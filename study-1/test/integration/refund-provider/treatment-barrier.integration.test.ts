// The treatment barrier over the store emulator on virtual time (BR-RUA-025, BR-RUA-012..014,
// OR-RUA-002): consistent polls every 250 ms, observe then release at once, the safety release
// at exactly 15 s after the commit acknowledgement, races with the controller and with cleanup
// settled by the conditional writes, and a fault for every state it cannot settle.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { TreatmentState } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import type { BarrierCommit, BarrierOutcome } from '../../../src/refund-provider/treatment-barrier.ts';
import { BARRIER_TIMING, TreatmentBarrier } from '../../../src/refund-provider/treatment-barrier.ts';
import { ATTEMPT_ID, field, SIGNAL_EVENT_ID, TRIAL_PK } from '../../unit/refund-provider/support/provider-fixtures.ts';
import { expectProviderFault } from './support/fault-assertions.ts';
import type { StateHarness } from './support/state-harness.ts';
import { journalEvents, stateHarness, stopJournal } from './support/state-harness.ts';

const COMMIT_ID = '33333333-0000-4000-8000-000000000001' as Uuid4;
const CALL_ID = '33333333-0000-4000-8000-000000000002' as Uuid4;
const COMMIT_EVENT_ID = '33333333-0000-4000-8000-000000000003' as Uuid4;
const OBSERVED_ID = '33333333-0000-4000-8000-000000000004' as Uuid4;
const TREATMENT_KEY = { pk: TRIAL_PK, sk: 'treatment' };

interface RunningBarrier {
  readonly result: Promise<BarrierOutcome>;
  readonly settled: () => boolean;
}

function seedWait(harness: StateHarness, state: TreatmentState, extra: JsonObject = {}): void {
  harness.store.seed('control', { ...TREATMENT_KEY, state, version: 2, provider_commit_id: COMMIT_ID, ...extra });
}

/** Starts the barrier for a commit acknowledged now, and lets it reach its first wait. */
async function startBarrier(harness: StateHarness): Promise<RunningBarrier> {
  const commit: BarrierCommit = {
    partition: TRIAL_PK,
    provider_commit_id: COMMIT_ID,
    provider_call_id: CALL_ID,
    attempt_id: ATTEMPT_ID,
    commit_event_id: COMMIT_EVENT_ID,
    commit_ack_ns: harness.time.nowNs(),
  };
  const barrier = new TreatmentBarrier({
    state: harness.state,
    journal: harness.journal,
    monotonic: harness.time,
    sleeper: harness.time,
    ids: harness.ids,
    pollIntervalMs: BARRIER_TIMING.poll_interval_ms,
    safetyReleaseMs: BARRIER_TIMING.safety_release_ms,
  });
  let done = false;
  const result = barrier.awaitRelease(commit);
  const markDone = (): void => {
    done = true;
  };
  result.then(markDone, markDone);
  await harness.time.advanceBy(0);
  return { result, settled: () => done };
}

/** Another writer's conditional treatment update (the controller or cleanup). */
async function moveTreatment(harness: StateHarness, from: TreatmentState, set: JsonObject): Promise<void> {
  const outcome = await harness.store.write({
    kind: 'update',
    table: 'control',
    key: TREATMENT_KEY,
    set,
    increment: { version: 1 },
    condition: { kind: 'attribute_equals', name: 'state', value: from },
  });
  assert.equal(outcome.kind, 'applied');
}

function signal(harness: StateHarness): Promise<void> {
  return moveTreatment(harness, 'COMMITTED_WAITING', { state: 'TIMEOUT_SIGNALLED', signal_event_id: SIGNAL_EVENT_ID });
}

function cleanup(harness: StateHarness, from: TreatmentState): Promise<void> {
  return moveTreatment(harness, from, { state: 'SAFETY_RELEASED', safety_release_cause: 'CLEANUP_REQUEST' });
}

function eventTypes(harness: StateHarness): readonly string[] {
  return journalEvents(harness).map((event) => event.record_type);
}

describe('TreatmentBarrier', () => {
  it('polls while waiting, then observes the signal and releases without another read', async () => {
    const harness = stateHarness();
    seedWait(harness, 'COMMITTED_WAITING');
    const running = await startBarrier(harness);
    await harness.time.advanceBy(1000);
    assert.equal(running.settled(), false);
    assert.equal(harness.time.pendingTimerCount(), 1);

    await signal(harness);
    await harness.time.advanceBy(BARRIER_TIMING.poll_interval_ms);
    assert.deepEqual(await running.result, { kind: 'released' });

    assert.deepEqual(eventTypes(harness), ['treatment_timeout_observed', 'treatment_response_released']);
    const [observed, released] = journalEvents(harness);
    assert.deepEqual(field(observed, 'causation_event_ids'), [SIGNAL_EVENT_ID]);
    assert.equal(field(observed, 'signal_event_id'), SIGNAL_EVENT_ID);
    assert.deepEqual(field(released, 'causation_event_ids'), [field(observed, 'event_id')]);
    const treatment = harness.store.peek('control', TREATMENT_KEY);
    assert.equal(field(treatment, 'state'), 'RESPONSE_RELEASED');
    assert.equal(field(treatment, 'version'), 5);
    assert.equal(field(treatment, 'observed_event_id'), field(observed, 'event_id'));
    assert.equal(field(treatment, 'release_event_id'), field(released, 'event_id'));
  });

  it('safety-releases an unsignalled wait at exactly 15 s after the commit acknowledgement', async () => {
    const harness = stateHarness();
    seedWait(harness, 'COMMITTED_WAITING');
    const running = await startBarrier(harness);
    await harness.time.advanceBy(BARRIER_TIMING.safety_release_ms - 1);
    assert.equal(running.settled(), false);
    await harness.time.advanceBy(1);
    assert.deepEqual(await running.result, { kind: 'safety_released' });

    const [released] = journalEvents(harness);
    assert.equal(field(released, 'record_type'), 'treatment_safety_released');
    assert.equal(field(released, 'cause'), 'SAFETY_DEADLINE');
    assert.equal(field(released, 'from_state'), 'COMMITTED_WAITING');
    assert.equal(field(released, 'elapsed_since_commit_ns'), '15000000000');
    assert.deepEqual(field(released, 'causation_event_ids'), [COMMIT_EVENT_ID]);
    const treatment = harness.store.peek('control', TREATMENT_KEY);
    assert.equal(field(treatment, 'state'), 'SAFETY_RELEASED');
    assert.equal(field(treatment, 'safety_release_cause'), 'SAFETY_DEADLINE');
  });

  it('safety-releases a signalled state that carries no signal identity, from that state', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED');
    const running = await startBarrier(harness);
    await harness.time.advanceBy(BARRIER_TIMING.safety_release_ms);
    assert.deepEqual(await running.result, { kind: 'safety_released' });
    assert.equal(field(journalEvents(harness)[0], 'from_state'), 'TIMEOUT_SIGNALLED');
  });

  it('treats a failed read as no news: waits one poll and reads again', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID });
    harness.store.scriptReadFault('InternalServerError', { table: 'control', operation: 'getConsistent' });
    const running = await startBarrier(harness);
    assert.equal(running.settled(), false);
    await harness.time.advanceBy(BARRIER_TIMING.poll_interval_ms);
    assert.deepEqual(await running.result, { kind: 'released' });
  });

  it('records the cleanup release that won the race against its observation', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID });
    harness.state.interposeBeforeTransition(() => cleanup(harness, 'TIMEOUT_SIGNALLED'));
    const running = await startBarrier(harness);
    assert.deepEqual(await running.result, { kind: 'externally_released', cause: 'CLEANUP_REQUEST' });

    assert.deepEqual(eventTypes(harness), ['treatment_safety_released']);
    const [released] = journalEvents(harness);
    assert.equal(field(released, 'cause'), 'CLEANUP_REQUEST');
    assert.equal(field(released, 'from_state'), 'TIMEOUT_SIGNALLED');
    assert.deepEqual(field(released, 'causation_event_ids'), [COMMIT_EVENT_ID]);
  });

  it('records a cleanup release that lands between its observation and its release', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID });
    harness.state.interposeBeforeTransition(() => Promise.resolve());
    harness.state.interposeBeforeTransition(() => cleanup(harness, 'TIMEOUT_OBSERVED'));
    const running = await startBarrier(harness);
    assert.deepEqual(await running.result, { kind: 'externally_released', cause: 'CLEANUP_REQUEST' });

    assert.deepEqual(eventTypes(harness), ['treatment_timeout_observed', 'treatment_safety_released']);
    assert.equal(field(journalEvents(harness)[1], 'from_state'), 'TIMEOUT_OBSERVED');
  });

  it('observes a signal that lands between its deadline read and its safety release', async () => {
    const harness = stateHarness();
    seedWait(harness, 'COMMITTED_WAITING');
    const running = await startBarrier(harness);
    harness.state.interposeBeforeTransition(() => signal(harness));
    await harness.time.advanceBy(BARRIER_TIMING.safety_release_ms);
    assert.deepEqual(await running.result, { kind: 'released' });

    const [lostSafety, observe, release] = harness.state.transitionsSeen();
    assert.equal(lostSafety?.to, 'SAFETY_RELEASED');
    assert.equal(observe?.to, 'TIMEOUT_OBSERVED');
    assert.equal(release?.to, 'RESPONSE_RELEASED');
    assert.deepEqual(eventTypes(harness), ['treatment_timeout_observed', 'treatment_response_released']);
  });

  it('retries a definitively failed transition after one poll, with a fresh token', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID });
    harness.store.scriptWriteFault(
      { kind: 'definitive_failure', code: 'InternalServerError' },
      { operation: 'transact' },
    );
    const running = await startBarrier(harness);
    assert.equal(running.settled(), false);
    await harness.time.advanceBy(BARRIER_TIMING.poll_interval_ms);
    assert.deepEqual(await running.result, { kind: 'released' });

    const [failed, retried] = harness.state.transitionsSeen();
    assert.equal(failed?.to, 'TIMEOUT_OBSERVED');
    assert.equal(retried?.to, 'TIMEOUT_OBSERVED');
    assert.notEqual(failed.token, retried.token);
  });

  it('retries a definitively failed release after one poll, from the observed state it reads', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_OBSERVED', { signal_event_id: SIGNAL_EVENT_ID, observed_event_id: OBSERVED_ID });
    harness.store.scriptWriteFault(
      { kind: 'definitive_failure', code: 'InternalServerError' },
      { operation: 'transact' },
    );
    const running = await startBarrier(harness);
    assert.equal(running.settled(), false);
    await harness.time.advanceBy(BARRIER_TIMING.poll_interval_ms);
    assert.deepEqual(await running.result, { kind: 'released' });
    assert.deepEqual(field(journalEvents(harness)[0], 'causation_event_ids'), [OBSERVED_ID]);
  });

  it('faults TREATMENT_UNEXPECTED when the treatment item vanished under a transition', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID });
    harness.state.scriptTransitionOutcome({ kind: 'condition_failed', failed_action_index: 0 });
    const fault = await expectProviderFault(
      (await startBarrier(harness)).result,
      'TREATMENT_UNEXPECTED',
      'after_commit',
    );
    assert.match(fault.message, /TIMEOUT_SIGNALLED -> TIMEOUT_OBSERVED found no treatment item/u);
  });

  it('faults TREATMENT_UNEXPECTED on a state its wait can never be in', async () => {
    const harness = stateHarness();
    seedWait(harness, 'ARMED');
    const fault = await expectProviderFault(
      (await startBarrier(harness)).result,
      'TREATMENT_UNEXPECTED',
      'after_commit',
    );
    assert.match(fault.message, /^TREATMENT_UNEXPECTED: treatment ARMED for commit /u);
  });

  it('faults TRANSITION_AMBIGUOUS and stops the instance on an unknown transition outcome (D-20)', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID });
    harness.store.scriptWriteFault(
      { kind: 'ambiguous', code: 'TimeoutError', applied: false },
      { operation: 'transact' },
    );
    await expectProviderFault((await startBarrier(harness)).result, 'TRANSITION_AMBIGUOUS', 'after_commit');
    assert.equal(harness.journal.isStopped(), true);
  });

  it('faults JOURNAL_STOPPED when a transition event cannot be prepared', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID });
    await stopJournal(harness);
    const fault = await expectProviderFault((await startBarrier(harness)).result, 'JOURNAL_STOPPED', 'after_commit');
    assert.match(fault.message, /treatment_timeout_observed not prepared \(INSTANCE_ALREADY_STOPPED\)/u);
    assert.equal(field(harness.store.peek('control', TREATMENT_KEY), 'state'), 'TIMEOUT_SIGNALLED');
  });

  it('faults JOURNAL_STOPPED when an external release cannot be recorded', async () => {
    const harness = stateHarness();
    seedWait(harness, 'SAFETY_RELEASED', { safety_release_cause: 'CLEANUP_REQUEST' });
    await stopJournal(harness);
    const fault = await expectProviderFault((await startBarrier(harness)).result, 'JOURNAL_STOPPED', 'after_commit');
    assert.match(fault.message, /treatment_safety_released not recorded \(INSTANCE_ALREADY_STOPPED\)/u);
  });
});
