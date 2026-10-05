// The provider state port over the durable item store (design §5.3, §9.3): consistent control
// reads decoded or refused with a code, the commit transaction under the plan's own token
// (D-23), and the conditional treatment transition carried with its journal put (BR-RUA-025).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDurableJournalPort } from '../../../src/event-journal/durable-journal-port.ts';
import type { PreparedJournalPut } from '../../../src/event-journal/journal-writer.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import type { Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import { commitEventBody, drawCommitIdentities, planCommit } from '../../../src/refund-provider/commit-plan.ts';
import { createProviderStatePort } from '../../../src/refund-provider/provider-state-port.ts';
import { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import {
  armedTreatmentItem,
  ATTEMPT_ID,
  EPOCH_MS,
  MANIFEST_SHA,
  PAYMENT_ID,
  paymentItem,
  PROBE_PK,
  probeConfigItem,
  PROVIDER_REQUEST_ID,
  REFUND_REQUEST_ID,
  RUN,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_PK,
  trialConfigItem,
} from './support/provider-fixtures.ts';

const CALL_ID = '12345678-0000-4000-8000-000000000001' as Uuid4;

interface PortHarness {
  readonly store: InMemoryItemStore;
  readonly ids: SequentialUuidSource;
  readonly writer: JournalWriter;
}

function portHarness(): PortHarness {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
  const store = new InMemoryItemStore({ clock: time });
  const ids = new SequentialUuidSource('77777777');
  const writer = new JournalWriter({
    port: createDurableJournalPort(store, 'experiment_journal'),
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
  return { store, ids, writer };
}

function reserve(writer: JournalWriter): PreparedJournalPut {
  const prepared = writer.prepare('treatment_response_released', {
    provider_commit_id: CALL_ID,
    provider_call_id: CALL_ID,
    attempt_id: ATTEMPT_ID,
  });
  if (prepared.kind !== 'prepared') {
    throw new Error(`prepare ${prepared.reason}; expected a reserved put`);
  }
  return prepared.put;
}

describe('ProviderStatePort reads', () => {
  it('reads absent control items as undefined', async () => {
    const state = createProviderStatePort(portHarness().store);
    assert.deepEqual(await state.loadTrialConfiguration({ key: TRIAL_PK, trial_id: TRIAL_ID }), {
      ok: true,
      value: undefined,
    });
    assert.deepEqual(await state.loadPayment(TRIAL_PK, PAYMENT_ID), { ok: true, value: undefined });
    assert.deepEqual(await state.loadTreatment(TRIAL_PK), { ok: true, value: undefined });
  });

  it('decodes the configuration, the named payment and the treatment', async () => {
    const { store } = portHarness();
    store.seed('control', trialConfigItem('CONTROL'));
    store.seed('control', probeConfigItem());
    store.seed('control', paymentItem(TRIAL_PK));
    store.seed('control', armedTreatmentItem(TRIAL_PK));
    const state = createProviderStatePort(store);
    const config = await state.loadTrialConfiguration({ key: TRIAL_PK, trial_id: TRIAL_ID });
    assert.equal(config.ok && config.value?.scenario, 'CONTROL');
    const probe = await state.loadTrialConfiguration({ key: PROBE_PK });
    assert.equal(probe.ok && probe.value?.registered_caller_id, 'probe');
    assert.deepEqual(await state.loadPayment(TRIAL_PK, PAYMENT_ID), {
      ok: true,
      value: { payment_id: PAYMENT_ID, currency: 'BRL' },
    });
    assert.deepEqual(await state.loadPayment(TRIAL_PK, 'pay-other'), { ok: true, value: undefined });
    assert.deepEqual(await state.loadTreatment(TRIAL_PK), { ok: true, value: { state: 'ARMED', version: 1 } });
  });

  it('reports a failed read with the store code and the item key', async () => {
    const { store } = portHarness();
    store.scriptReadFault('ProvisionedThroughputExceededException');
    assert.deepEqual(await createProviderStatePort(store).loadTreatment(TRIAL_PK), {
      ok: false,
      error: {
        code: 'ProvisionedThroughputExceededException',
        detail: `control read ${TRIAL_PK}/treatment failed: ProvisionedThroughputExceededException`,
      },
    });
  });

  it('reports an undecodable item with UndecodableItem and the decoder detail', async () => {
    const { store } = portHarness();
    store.seed('control', paymentItem(TRIAL_PK, { currency: 7 }));
    assert.deepEqual(await createProviderStatePort(store).loadPayment(TRIAL_PK, PAYMENT_ID), {
      ok: false,
      error: {
        code: 'UndecodableItem',
        detail: `control item ${TRIAL_PK}/payment#${PAYMENT_ID}: currency number 7; expected a string`,
      },
    });
  });
});

describe('ProviderStatePort writes', () => {
  it('commits under the plan own token, so a replay of the same plan is idempotent (D-23)', async () => {
    const { store, ids, writer } = portHarness();
    const identities = drawCommitIdentities(ids);
    const requestedAt = '2026-10-05T12:00:00.000Z' as UtcMillis;
    const call = {
      caller_id: 'conventional' as const,
      attempt_id: ATTEMPT_ID,
      provider_request_id: PROVIDER_REQUEST_ID,
      refund_request_id: REFUND_REQUEST_ID,
      payment_id: PAYMENT_ID,
      amount_minor: 10000,
      currency: 'BRL',
    };
    const prepared = writer.prepare(
      'provider_transaction_committed',
      commitEventBody(call, CALL_ID, identities, false, requestedAt),
    );
    assert.equal(prepared.kind, 'prepared');
    const plan = planCommit({
      kind: 'untargeted',
      partition: TRIAL_PK,
      call,
      provider_call_id: CALL_ID,
      identities,
      commit_requested_at: requestedAt,
      commit_event: prepared.put,
    });
    const state = createProviderStatePort(store);
    assert.deepEqual(await state.commit(plan), { kind: 'applied' });
    assert.deepEqual(await state.commit(plan), { kind: 'applied' });
    assert.equal(store.itemsIn('ledger').length, 1);
    assert.equal(store.itemsIn('experiment_journal').length, 1);
  });

  it('applies a transition with its attributes, version increment and journal put', async () => {
    const { store, ids, writer } = portHarness();
    store.seed('control', { pk: TRIAL_PK, sk: 'treatment', state: 'TIMEOUT_OBSERVED', version: 4 });
    const put = reserve(writer);
    const outcome = await createProviderStatePort(store).transition({
      partition: TRIAL_PK,
      from: 'TIMEOUT_OBSERVED',
      to: 'RESPONSE_RELEASED',
      set: { release_event_id: put.event.event_id },
      event: put,
      token: ids.next(),
    });
    assert.deepEqual(outcome, { kind: 'applied' });
    assert.deepEqual(store.peek('control', { pk: TRIAL_PK, sk: 'treatment' }), {
      pk: TRIAL_PK,
      sk: 'treatment',
      state: 'RESPONSE_RELEASED',
      version: 5,
      release_event_id: put.event.event_id,
    });
    assert.deepEqual(store.peek('experiment_journal', put.key), put.item);
  });

  it('refuses a transition from a state the item is not in, writing nothing', async () => {
    const { store, ids, writer } = portHarness();
    store.seed('control', armedTreatmentItem(TRIAL_PK));
    const put = reserve(writer);
    const outcome = await createProviderStatePort(store).transition({
      partition: TRIAL_PK,
      from: 'TIMEOUT_OBSERVED',
      to: 'RESPONSE_RELEASED',
      set: {},
      event: put,
      token: ids.next(),
    });
    assert.deepEqual(outcome, {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: armedTreatmentItem(TRIAL_PK),
    });
    assert.equal(store.itemsIn('experiment_journal').length, 0);
  });
});
