// The commit plan (BR-RUA-016, BR-RUA-025, D-23): one transaction holding the immutable
// SUCCEEDED ledger transaction, the in-transaction commit event and, when targeted, the
// treatment update `ARMED -> COMMITTED_WAITING` that records every identity. The token is the
// plan's own provider_commit_id, and every plan draws fresh identities.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PreparedJournalPut } from '../../../src/event-journal/journal-writer.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import { createDurableJournalPort } from '../../../src/event-journal/durable-journal-port.ts';
import type { Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { AcceptedCall } from '../../../src/refund-provider/acceptance.ts';
import type { CommitIdentities } from '../../../src/refund-provider/commit-plan.ts';
import {
  commitEventBody,
  commitToken,
  drawCommitIdentities,
  ledgerSortKey,
  planCommit,
} from '../../../src/refund-provider/commit-plan.ts';
import { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import {
  ATTEMPT_ID,
  EPOCH_MS,
  MANIFEST_SHA,
  PAYMENT_ID,
  PROVIDER_REQUEST_ID,
  REFUND_REQUEST_ID,
  RUN,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_PK,
} from './support/provider-fixtures.ts';

const CALL: AcceptedCall = {
  caller_id: 'conventional',
  attempt_id: ATTEMPT_ID,
  provider_request_id: PROVIDER_REQUEST_ID,
  refund_request_id: REFUND_REQUEST_ID,
  payment_id: PAYMENT_ID,
  amount_minor: 10000,
  currency: 'BRL',
};
const CALL_ID = '12345678-0000-4000-8000-000000000001' as Uuid4;
const REQUESTED_AT = '2026-10-05T12:00:01.000Z' as UtcMillis;

interface PreparedCommit {
  readonly identities: CommitIdentities;
  readonly put: PreparedJournalPut;
}

/** Reserves a real `provider_transaction_committed` put, as the provider does before planning. */
function preparedCommitEvent(targeted: boolean): PreparedCommit {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
  const ids = new SequentialUuidSource('77777777');
  const writer = new JournalWriter({
    port: createDurableJournalPort(new InMemoryItemStore({ clock: time }), 'experiment_journal'),
    source: 'refund_provider',
    instanceId: ids.next(),
    scope: {
      execution: RUN,
      execution_manifest_sha256: MANIFEST_SHA,
      partition: { kind: 'trial', trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
    },
    clock: time,
    ids,
    maxDefinitiveRetries: 0,
  });
  const identities = drawCommitIdentities(ids);
  const prepared = writer.prepare(
    'provider_transaction_committed',
    commitEventBody(CALL, CALL_ID, identities, targeted, REQUESTED_AT),
  );
  assert.equal(prepared.kind, 'prepared');
  return { identities, put: prepared.put };
}

describe('drawCommitIdentities', () => {
  it('draws a fresh commit id and transaction id for every plan (D-23)', () => {
    const ids = new SequentialUuidSource('66666666');
    const first = drawCommitIdentities(ids);
    const second = drawCommitIdentities(ids);
    assert.deepEqual(first, {
      provider_commit_id: '66666666-0000-4000-8000-000000000001',
      provider_transaction_id: '66666666-0000-4000-8000-000000000002',
    });
    assert.notEqual(second.provider_commit_id, first.provider_commit_id);
    assert.notEqual(second.provider_transaction_id, first.provider_transaction_id);
  });
});

describe('commitEventBody', () => {
  it('carries the commit triple, the attempt correlation, the effect and the targeting flag', () => {
    const identities = { provider_commit_id: CALL_ID, provider_transaction_id: ATTEMPT_ID };
    assert.deepEqual(commitEventBody(CALL, CALL_ID, identities, true, REQUESTED_AT), {
      provider_commit_id: CALL_ID,
      provider_transaction_id: ATTEMPT_ID,
      provider_call_id: CALL_ID,
      attempt_id: ATTEMPT_ID,
      provider_request_id: PROVIDER_REQUEST_ID,
      refund_request_id: REFUND_REQUEST_ID,
      payment_id: PAYMENT_ID,
      amount_minor: 10000,
      currency: 'BRL',
      targeted: true,
      commit_requested_at: REQUESTED_AT,
    });
    assert.equal(commitEventBody(CALL, CALL_ID, identities, false, REQUESTED_AT).targeted, false);
  });
});

describe('planCommit', () => {
  it('plans an untargeted commit: the ledger put and the commit event only', () => {
    const { identities, put } = preparedCommitEvent(false);
    const plan = planCommit({
      kind: 'untargeted',
      partition: TRIAL_PK,
      call: CALL,
      provider_call_id: CALL_ID,
      identities,
      commit_requested_at: REQUESTED_AT,
      commit_event: put,
    });
    assert.equal(plan.kind, 'untargeted');
    assert.equal(plan.treatment_action_index, undefined);
    assert.equal('treatment_action_index' in plan, false);
    assert.deepEqual(plan.ids, { ...identities, commit_event_id: put.event.event_id });
    assert.equal(plan.provider_call_id, CALL_ID);
    assert.equal(plan.commit_requested_at, REQUESTED_AT);
    assert.deepEqual(plan.actions, [
      {
        kind: 'put',
        table: 'ledger',
        item: {
          pk: TRIAL_PK,
          sk: `tx#${identities.provider_transaction_id}`,
          provider_transaction_id: identities.provider_transaction_id,
          provider_commit_id: identities.provider_commit_id,
          provider_call_id: CALL_ID,
          attempt_id: ATTEMPT_ID,
          provider_request_id: PROVIDER_REQUEST_ID,
          refund_request_id: REFUND_REQUEST_ID,
          payment_id: PAYMENT_ID,
          amount_minor: 10000,
          currency: 'BRL',
          status: 'SUCCEEDED',
          commit_requested_at: REQUESTED_AT,
        },
        condition: { kind: 'item_absent' },
      },
      { kind: 'put', table: 'experiment_journal', item: put.item, condition: { kind: 'item_absent' } },
    ]);
  });

  it('plans a targeted commit that consumes ARMED treatment and records every identity', () => {
    const { identities, put } = preparedCommitEvent(true);
    const plan = planCommit({
      kind: 'targeted',
      partition: TRIAL_PK,
      call: CALL,
      provider_call_id: CALL_ID,
      identities,
      commit_requested_at: REQUESTED_AT,
      commit_event: put,
    });
    assert.equal(plan.kind, 'targeted');
    assert.equal(plan.treatment_action_index, 2);
    assert.equal(plan.actions.length, 3);
    assert.deepEqual(plan.actions[2], {
      kind: 'update',
      table: 'control',
      key: { pk: TRIAL_PK, sk: 'treatment' },
      set: {
        state: 'COMMITTED_WAITING',
        targeted_attempt_id: ATTEMPT_ID,
        provider_request_id: PROVIDER_REQUEST_ID,
        provider_call_id: CALL_ID,
        provider_commit_id: identities.provider_commit_id,
        provider_transaction_id: identities.provider_transaction_id,
        commit_event_id: put.event.event_id,
      },
      increment: { version: 1 },
      condition: { kind: 'attribute_equals', name: 'state', value: 'ARMED' },
    });
  });

  it('uses the plan own provider_commit_id as the ClientRequestToken', () => {
    const { identities, put } = preparedCommitEvent(false);
    const plan = planCommit({
      kind: 'untargeted',
      partition: TRIAL_PK,
      call: CALL,
      provider_call_id: CALL_ID,
      identities,
      commit_requested_at: REQUESTED_AT,
      commit_event: put,
    });
    assert.equal(commitToken(plan), identities.provider_commit_id);
    assert.equal(ledgerSortKey(identities.provider_transaction_id), `tx#${identities.provider_transaction_id}`);
  });
});
