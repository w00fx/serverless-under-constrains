// Conformance of ScriptedProviderStatePort (design §12.2, RK-17). The fake must not let a suite
// prove anything the real boundary cannot produce: an unscripted call reaches the real
// `createProviderStatePort` over the InMemoryItemStore emulator and returns, and stores, exactly
// what the real port does; each scripted outcome the suites use equals what the real port
// returns once the store holds the matching state. The emulator's own conformance
// (`test/integration/durable-store/fakes/`) ties those outcomes to DynamoDB: a failed condition
// returns the first failing action's index and that item as it was (ALL_OLD,
// ReturnValuesOnConditionCheckFailure; API_TransactWriteItems, [R-aws] §1.2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StoredItem, WriteOutcome } from '../../../../src/durable-store/item-store-port.ts';
import type { Uuid4 } from '../../../../src/record-contract/primitives.ts';
import type { AcceptedCall } from '../../../../src/refund-provider/acceptance.ts';
import type { CommitKind, CommitPlan } from '../../../../src/refund-provider/commit-plan.ts';
import { executeCommit } from '../../../../src/refund-provider/commit-execution.ts';
import type { ProviderStatePort, TreatmentTransition } from '../../../../src/refund-provider/provider-state-port.ts';
import { createProviderStatePort } from '../../../../src/refund-provider/provider-state-port.ts';
import { InMemoryItemStore } from '../../../support/durable-store/in-memory-item-store.ts';
import {
  armedTreatmentItem,
  ATTEMPT_ID,
  PAYMENT_ID,
  paymentItem,
  PROVIDER_REQUEST_ID,
  REFUND_REQUEST_ID,
  SIGNAL_EVENT_ID,
  TRIAL_ID,
  TRIAL_PK,
  trialConfigItem,
} from '../../../support/refund-provider/provider-fixtures.ts';
import {
  journalHolderOf,
  journalKeyHeldBy,
  ledgerItemAlreadyExists,
  ledgerKeyOf,
} from '../support/scripted-provider-state-port.ts';
import type { CommitResponder } from '../support/scripted-provider-state-port.ts';
import type { StateHarness } from '../support/state-harness.ts';
import { stateHarness } from '../support/state-harness.ts';

const CALL: AcceptedCall = {
  caller_id: 'conventional',
  attempt_id: ATTEMPT_ID,
  provider_request_id: PROVIDER_REQUEST_ID,
  refund_request_id: REFUND_REQUEST_ID,
  payment_id: PAYMENT_ID,
  amount_minor: 10000,
  currency: 'BRL',
};
const CALL_ID = '44444444-0000-4000-8000-000000000001' as Uuid4;
const ACCEPTED_EVENT_ID = '44444444-0000-4000-8000-000000000002' as Uuid4;
const HOLDER_EVENT_ID = '44444444-0000-4000-8000-000000000003' as Uuid4;
const TREATMENT_KEY = { pk: TRIAL_PK, sk: 'treatment' };

function seedTrial(harness: StateHarness): void {
  harness.store.seed('control', trialConfigItem('COMMIT_THEN_TIMEOUT'));
  harness.store.seed('control', paymentItem(TRIAL_PK));
  harness.store.seed('control', armedTreatmentItem(TRIAL_PK));
}

function commitThrough(harness: StateHarness, state: ProviderStatePort, kind: CommitKind): Promise<unknown> {
  const request = {
    partition: TRIAL_PK,
    call: CALL,
    provider_call_id: CALL_ID,
    accepted_event_id: ACCEPTED_EVENT_ID,
    kind,
  };
  return executeCommit(
    { state, journal: harness.journal, ids: harness.ids, wall: harness.time, monotonic: harness.time },
    request,
  ).then(
    (value) => value,
    (error: unknown) => error,
  );
}

/** The plan a scripted commit answered: the provider draws its identities, so the fake records it. */
async function scriptedPlan(responder: CommitResponder): Promise<CommitPlan> {
  const harness = stateHarness();
  seedTrial(harness);
  harness.state.scriptCommitResponder(responder);
  await commitThrough(harness, harness.state, 'targeted');
  const [plan] = harness.state.commitsSeen();
  assert.ok(plan !== undefined);
  return plan;
}

/** The real port's commit of `plan` on a fresh emulator preloaded with `held`. */
async function realCommit(
  plan: CommitPlan,
  held: { readonly table: 'ledger' | 'experiment_journal'; readonly item: StoredItem },
): Promise<{
  readonly outcome: WriteOutcome;
  readonly store: InMemoryItemStore;
}> {
  const store = new InMemoryItemStore({ clock: stateHarness().time });
  store.seed('control', armedTreatmentItem(TRIAL_PK));
  store.seed(held.table, held.item);
  return { outcome: await createProviderStatePort(store).commit(plan), store };
}

function observeTransition(harness: StateHarness): TreatmentTransition {
  const prepared = harness.journal.prepare(
    'treatment_timeout_observed',
    {
      provider_commit_id: CALL_ID,
      provider_call_id: CALL_ID,
      attempt_id: ATTEMPT_ID,
      signal_event_id: SIGNAL_EVENT_ID,
    },
    [SIGNAL_EVENT_ID],
  );
  assert.equal(prepared.kind, 'prepared');
  return {
    partition: TRIAL_PK,
    from: 'TIMEOUT_SIGNALLED',
    to: 'TIMEOUT_OBSERVED',
    set: { observed_event_id: prepared.put.event.event_id },
    event: prepared.put,
    token: harness.ids.next(),
  };
}

describe('ScriptedProviderStatePort pass-through', () => {
  it('returns and stores exactly what the real port does when nothing is scripted', async () => {
    const real = stateHarness();
    const faked = stateHarness();
    for (const harness of [real, faked]) {
      seedTrial(harness);
    }
    const realPort = createProviderStatePort(real.store);
    const partition = { key: TRIAL_PK, trial_id: TRIAL_ID };
    assert.deepEqual(
      await faked.state.loadTrialConfiguration(partition),
      await realPort.loadTrialConfiguration(partition),
    );
    assert.deepEqual(
      await faked.state.loadPayment(TRIAL_PK, PAYMENT_ID),
      await realPort.loadPayment(TRIAL_PK, PAYMENT_ID),
    );
    assert.deepEqual(await faked.state.loadTreatment(TRIAL_PK), await realPort.loadTreatment(TRIAL_PK));
    assert.deepEqual(
      await commitThrough(faked, faked.state, 'targeted'),
      await commitThrough(real, realPort, 'targeted'),
    );

    real.store.seed('control', {
      ...TREATMENT_KEY,
      state: 'TIMEOUT_SIGNALLED',
      version: 3,
      signal_event_id: SIGNAL_EVENT_ID,
    });
    faked.store.seed('control', {
      ...TREATMENT_KEY,
      state: 'TIMEOUT_SIGNALLED',
      version: 3,
      signal_event_id: SIGNAL_EVENT_ID,
    });
    const realOutcome = await realPort.transition(observeTransition(real));
    assert.deepEqual(await faked.state.transition(observeTransition(faked)), realOutcome);
    assert.deepEqual(realOutcome, { kind: 'applied' });

    for (const table of ['control', 'ledger', 'experiment_journal'] as const) {
      assert.deepEqual(faked.store.itemsIn(table), real.store.itemsIn(table), table);
    }
    assert.equal(faked.state.commitsSeen().length, 1);
    assert.equal(faked.state.transitionsSeen().length, 1);
    assert.equal(faked.state.treatmentReadCount(), 1);
  });
});

describe('ScriptedProviderStatePort scripted outcomes match the real port', () => {
  it('ledgerItemAlreadyExists is the real commit outcome when the plan ledger item exists', async () => {
    const plan = await scriptedPlan(ledgerItemAlreadyExists);
    const { outcome, store } = await realCommit(plan, { table: 'ledger', item: ledgerKeyOf(plan) });
    assert.deepEqual(ledgerItemAlreadyExists(plan), outcome);
    assert.deepEqual(outcome, { kind: 'condition_failed', failed_action_index: 0, existing: ledgerKeyOf(plan) });
    assert.deepEqual(store.peek('control', TREATMENT_KEY), armedTreatmentItem(TRIAL_PK));
    assert.deepEqual(store.itemsIn('experiment_journal'), []);
  });

  it('journalKeyHeldBy is the real commit outcome when another event holds the journal key', async () => {
    const responder = journalKeyHeldBy(HOLDER_EVENT_ID);
    const plan = await scriptedPlan(responder);
    const holder = journalHolderOf(plan, HOLDER_EVENT_ID);
    const { outcome, store } = await realCommit(plan, { table: 'experiment_journal', item: holder });
    assert.deepEqual(responder(plan), outcome);
    assert.equal(outcome.kind === 'condition_failed' ? outcome.failed_action_index : -1, 1);
    assert.deepEqual(store.itemsIn('ledger'), []);
    assert.deepEqual(store.itemsIn('experiment_journal'), [holder]);
  });

  it('a transition failing on a vanished item is the real outcome when the treatment item is absent', async () => {
    const harness = stateHarness();
    const outcome = await createProviderStatePort(harness.store).transition(observeTransition(harness));
    assert.deepEqual(outcome, { kind: 'condition_failed', failed_action_index: 0 });
    assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
  });

  it('a scripted transition outcome never reaches the store', async () => {
    const harness = stateHarness();
    harness.store.seed('control', { ...TREATMENT_KEY, state: 'TIMEOUT_SIGNALLED', version: 3 });
    harness.state.scriptTransitionOutcome({ kind: 'condition_failed', failed_action_index: 0 });
    assert.deepEqual(await harness.state.transition(observeTransition(harness)), {
      kind: 'condition_failed',
      failed_action_index: 0,
    });
    assert.equal(harness.store.peek('control', TREATMENT_KEY)?.['state'], 'TIMEOUT_SIGNALLED');
    assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
  });

  it('an interposed writer acts on the real store before the real transition', async () => {
    const harness = stateHarness();
    harness.store.seed('control', { ...TREATMENT_KEY, state: 'TIMEOUT_SIGNALLED', version: 3 });
    harness.state.interposeBeforeTransition(async () => {
      harness.store.seed('control', { ...TREATMENT_KEY, state: 'SAFETY_RELEASED', version: 4 });
      await Promise.resolve();
    });
    assert.deepEqual(await harness.state.transition(observeTransition(harness)), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: { ...TREATMENT_KEY, state: 'SAFETY_RELEASED', version: 4 },
    });
  });
});
