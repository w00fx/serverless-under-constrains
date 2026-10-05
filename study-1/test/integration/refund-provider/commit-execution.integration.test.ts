// The provider commit over the store emulator (BR-RUA-016, BR-RUA-025, D-20, D-23, D-24): one
// transaction holds the ledger transaction and the commit event, plus the treatment update when
// targeted; a lost treatment re-plans untargeted with fresh identities and a fresh token; a
// definitive failure is recorded and faults; an unknown outcome stops the source instance.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { AcceptedCall } from '../../../src/refund-provider/acceptance.ts';
import type { CommitRequest } from '../../../src/refund-provider/commit-execution.ts';
import { executeCommit } from '../../../src/refund-provider/commit-execution.ts';
import type { CommitKind } from '../../../src/refund-provider/commit-plan.ts';
import { commitToken } from '../../../src/refund-provider/commit-plan.ts';
import {
  armedTreatmentItem,
  ATTEMPT_ID,
  field,
  PAYMENT_ID,
  PROVIDER_REQUEST_ID,
  REFUND_REQUEST_ID,
  TRIAL_PK,
} from '../../unit/refund-provider/support/provider-fixtures.ts';
import { expectProviderFault } from './support/fault-assertions.ts';
import type { StateHarness } from './support/state-harness.ts';
import { journalEvents, stateHarness, stopJournal } from './support/state-harness.ts';

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
const ACCEPTED_EVENT_ID = '12345678-0000-4000-8000-000000000002' as Uuid4;

function request(kind: CommitKind): CommitRequest {
  return { partition: TRIAL_PK, call: CALL, provider_call_id: CALL_ID, accepted_event_id: ACCEPTED_EVENT_ID, kind };
}

function commitFor(harness: StateHarness, kind: CommitKind): ReturnType<typeof executeCommit> {
  const { state, journal, ids, time } = harness;
  return executeCommit({ state, journal, ids, wall: time, monotonic: time }, request(kind));
}

function eventTypes(harness: StateHarness): readonly string[] {
  return journalEvents(harness).map((event) => event.record_type);
}

describe('executeCommit', () => {
  it('commits an untargeted call and confirms it, caused by the in-transaction commit event', async () => {
    const harness = stateHarness();
    const ackNs = harness.time.nowNs();
    const confirmed = await commitFor(harness, 'untargeted');

    assert.equal(confirmed.plan.kind, 'untargeted');
    assert.equal(confirmed.commit_ack_ns, ackNs);
    assert.deepEqual(eventTypes(harness), ['provider_transaction_committed', 'provider_commit_confirmed']);
    const [committed, confirmation] = journalEvents(harness);
    assert.equal(field(committed, 'event_id'), confirmed.plan.ids.commit_event_id);
    assert.deepEqual(field(committed, 'causation_event_ids'), [ACCEPTED_EVENT_ID]);
    assert.equal(field(confirmation, 'event_id'), confirmed.confirmed_event_id);
    assert.deepEqual(field(confirmation, 'causation_event_ids'), [confirmed.plan.ids.commit_event_id]);
    assert.equal(field(confirmation, 'committed_at'), '2026-10-05T12:00:00.000Z');
    assert.equal(field(confirmation, 'provider_transaction_id'), confirmed.plan.ids.provider_transaction_id);
    const ledger = harness.store.itemsIn('ledger');
    assert.equal(ledger.length, 1);
    assert.equal(field(ledger[0], 'status'), 'SUCCEEDED');
  });

  it('commits a targeted call by consuming the ARMED treatment in the same transaction', async () => {
    const harness = stateHarness();
    harness.store.seed('control', armedTreatmentItem(TRIAL_PK));
    const confirmed = await commitFor(harness, 'targeted');

    assert.equal(confirmed.plan.kind, 'targeted');
    const treatment = harness.store.peek('control', { pk: TRIAL_PK, sk: 'treatment' });
    assert.equal(field(treatment, 'state'), 'COMMITTED_WAITING');
    assert.equal(field(treatment, 'version'), 2);
    assert.equal(field(treatment, 'provider_commit_id'), confirmed.plan.ids.provider_commit_id);
    assert.equal(field(treatment, 'commit_event_id'), confirmed.plan.ids.commit_event_id);
    assert.equal(field(journalEvents(harness)[0], 'targeted'), true);
  });

  it('re-plans untargeted with fresh identities and token when the treatment is no longer ARMED', async () => {
    const harness = stateHarness();
    const consumed: StoredItem = { pk: TRIAL_PK, sk: 'treatment', state: 'COMMITTED_WAITING', version: 2 };
    harness.store.seed('control', consumed);
    const confirmed = await commitFor(harness, 'targeted');

    const [lost, replanned] = harness.state.commitsSeen();
    assert.ok(lost !== undefined && replanned !== undefined);
    assert.equal(lost.kind, 'targeted');
    assert.equal(replanned.kind, 'untargeted');
    assert.equal(confirmed.plan, replanned);
    assert.notEqual(replanned.ids.provider_commit_id, lost.ids.provider_commit_id);
    assert.notEqual(replanned.ids.provider_transaction_id, lost.ids.provider_transaction_id);
    assert.notEqual(replanned.ids.commit_event_id, lost.ids.commit_event_id);
    assert.notEqual(commitToken(replanned), commitToken(lost));
    assert.deepEqual(harness.store.peek('control', { pk: TRIAL_PK, sk: 'treatment' }), consumed);
    assert.deepEqual(eventTypes(harness), ['provider_transaction_committed', 'provider_commit_confirmed']);
    assert.equal(field(journalEvents(harness)[0], 'targeted'), false);
    // The lost transaction wrote nothing, so the re-plan reuses the freed journal sequence.
    const lostPut = lost.actions[1];
    assert.equal(
      field(journalEvents(harness)[0], 'source_sequence'),
      lostPut?.kind === 'put' ? lostPut.item['source_sequence'] : undefined,
    );
  });

  it('records a definitive failure as provider_commit_failed and faults COMMIT_FAILED', async () => {
    const harness = stateHarness();
    harness.store.scriptWriteFault(
      { kind: 'definitive_failure', code: 'InternalServerError' },
      { operation: 'transact' },
    );
    const fault = await expectProviderFault(commitFor(harness, 'untargeted'), 'COMMIT_FAILED', 'before_commit');

    assert.equal(fault.providerCallId, CALL_ID);
    assert.deepEqual(eventTypes(harness), ['provider_commit_failed']);
    const [failed] = journalEvents(harness);
    assert.equal(field(failed, 'error_code'), 'InternalServerError');
    assert.equal(field(failed, 'targeted'), false);
    assert.deepEqual(field(failed, 'causation_event_ids'), [ACCEPTED_EVENT_ID]);
    assert.deepEqual(harness.store.itemsIn('ledger'), []);
  });

  it('records a failed ledger condition as TransactionConditionFailed without re-planning', async () => {
    const harness = stateHarness();
    harness.store.seed('control', armedTreatmentItem(TRIAL_PK));
    harness.state.scriptCommitResponder((plan) => ({
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: { pk: TRIAL_PK, sk: `tx#${plan.ids.provider_transaction_id}` },
    }));
    await expectProviderFault(commitFor(harness, 'targeted'), 'COMMIT_FAILED', 'before_commit');

    assert.equal(harness.state.commitsSeen().length, 1);
    const [failed] = journalEvents(harness);
    assert.equal(field(failed, 'error_code'), 'TransactionConditionFailed');
    assert.equal(field(failed, 'targeted'), true);
  });

  it('faults COMMIT_AMBIGUOUS and stops the instance when the outcome is unknown (D-20)', async () => {
    const harness = stateHarness();
    harness.store.scriptWriteFault(
      { kind: 'ambiguous', code: 'TimeoutError', applied: true },
      { operation: 'transact' },
    );
    const fault = await expectProviderFault(commitFor(harness, 'untargeted'), 'COMMIT_AMBIGUOUS', 'commit_unknown');

    assert.match(fault.message, /stopped the instance \(AMBIGUOUS_APPEND\)/u);
    assert.equal(harness.journal.isStopped(), true);
    assert.deepEqual(eventTypes(harness), ['provider_transaction_committed']);
  });

  it('faults JOURNAL_STOPPED when the commit event collides with another event at its sequence', async () => {
    const harness = stateHarness();
    harness.state.scriptCommitResponder((plan) => {
      const journalPut = plan.actions[1];
      const item = journalPut?.kind === 'put' ? journalPut.item : { pk: '', sk: '' };
      return { kind: 'condition_failed', failed_action_index: 1, existing: { ...item, event_id: CALL_ID } };
    });
    const fault = await expectProviderFault(commitFor(harness, 'untargeted'), 'JOURNAL_STOPPED', 'commit_unknown');

    assert.match(fault.message, /\(SEQUENCE_CONFLICT\)/u);
    assert.equal(harness.journal.isStopped(), true);
  });

  it('faults before committing when the commit event cannot be prepared', async () => {
    const harness = stateHarness();
    await stopJournal(harness);
    const fault = await expectProviderFault(commitFor(harness, 'untargeted'), 'JOURNAL_STOPPED', 'before_commit');

    assert.match(fault.message, /provider_transaction_committed not prepared \(INSTANCE_ALREADY_STOPPED\)/u);
    assert.deepEqual(harness.state.commitsSeen(), []);
  });

  it('faults JOURNAL_STOPPED when the failure itself cannot be recorded', async () => {
    const harness = stateHarness();
    harness.store.scriptWriteFault(
      { kind: 'definitive_failure', code: 'InternalServerError' },
      { operation: 'transact' },
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      harness.store.scriptWriteFault(
        { kind: 'definitive_failure', code: 'InternalServerError' },
        { operation: 'write' },
      );
    }
    const fault = await expectProviderFault(commitFor(harness, 'untargeted'), 'JOURNAL_STOPPED', 'before_commit');

    assert.match(
      fault.message,
      /^JOURNAL_STOPPED: provider_commit_failed not recorded \(DEFINITIVE_RETRIES_EXHAUSTED\)/u,
    );
    assert.deepEqual(journalEvents(harness), []);
  });

  it('faults after the commit when the confirmation cannot be recorded; the transaction stands', async () => {
    const harness = stateHarness();
    harness.store.scriptWriteFault({ kind: 'ambiguous', code: 'TimeoutError', applied: false }, { operation: 'write' });
    const fault = await expectProviderFault(commitFor(harness, 'untargeted'), 'JOURNAL_STOPPED', 'after_commit');

    assert.match(fault.message, /provider_commit_confirmed not recorded \(AMBIGUOUS_APPEND\)/u);
    assert.equal(harness.store.itemsIn('ledger').length, 1);
    assert.deepEqual(eventTypes(harness), ['provider_transaction_committed']);
  });
});
