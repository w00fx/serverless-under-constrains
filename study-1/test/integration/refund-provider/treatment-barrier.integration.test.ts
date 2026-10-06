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
    log: harness.logs.sink,
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

  it('treats a failed read as no news: logs it, waits one poll and reads again', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID });
    harness.store.scriptReadFault('InternalServerError', { table: 'control', operation: 'getConsistent' });
    const running = await startBarrier(harness);
    assert.equal(running.settled(), false);
    // WP-07 review round 0: the failed read used to be swallowed without a trace.
    assert.deepEqual(harness.logs.lines(), [
      {
        level: 'warn',
        event: 'treatment_read_failed',
        provider_call_id: CALL_ID,
        code: 'InternalServerError',
        detail: `control read ${TRIAL_PK}/treatment failed: InternalServerError`,
      },
    ]);
    await harness.time.advanceBy(BARRIER_TIMING.poll_interval_ms);
    assert.deepEqual(await running.result, { kind: 'released' });
    assert.equal(harness.logs.lines().length, 1);
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

  // WP-07 review round 1: with every read failing after the deadline, a lost safety release used
  // to re-read and retry at once, issuing transactions with no wait until the Lambda timeout.
  it('settles from the superseding item when reads keep failing past the deadline, without spinning', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID });
    for (let read = 0; read < 200; read += 1) {
      harness.store.scriptReadFault('InternalServerError', { table: 'control', operation: 'getConsistent' });
    }
    const running = await startBarrier(harness);
    await harness.time.advanceBy(BARRIER_TIMING.safety_release_ms - 1);
    assert.equal(running.settled(), false);
    assert.equal(harness.state.transitionsSeen().length, 0);
    await harness.time.advanceBy(1);
    assert.deepEqual(await running.result, { kind: 'released' });

    assert.deepEqual(
      harness.state.transitionsSeen().map((transition) => `${transition.from}->${transition.to}`),
      [
        'COMMITTED_WAITING->SAFETY_RELEASED',
        'TIMEOUT_SIGNALLED->TIMEOUT_OBSERVED',
        'TIMEOUT_OBSERVED->RESPONSE_RELEASED',
      ],
    );
    assert.equal(
      harness.state.treatmentReadCount(),
      BARRIER_TIMING.safety_release_ms / BARRIER_TIMING.poll_interval_ms + 1,
    );
    assert.deepEqual(eventTypes(harness), ['treatment_timeout_observed', 'treatment_response_released']);
    assert.deepEqual(field(journalEvents(harness)[0], 'causation_event_ids'), [SIGNAL_EVENT_ID]);
    assert.deepEqual(new Set(harness.logs.lines().map((line) => line.event)), new Set(['treatment_read_failed']));
    assert.equal(harness.logs.lines().length, harness.state.treatmentReadCount());
  });

  it('faults STATE_UNREADABLE when the superseding item cannot be decoded, after one transition', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID, safety_release_cause: 'BOGUS' });
    const running = await startBarrier(harness);
    await harness.time.advanceBy(BARRIER_TIMING.safety_release_ms - 1);
    assert.equal(running.settled(), false);
    assert.equal(harness.state.transitionsSeen().length, 0);
    await harness.time.advanceBy(1);
    const fault = await expectProviderFault(running.result, 'STATE_UNREADABLE', 'after_commit');

    assert.match(
      fault.message,
      /^STATE_UNREADABLE: COMMITTED_WAITING -> SAFETY_RELEASED was superseded by an undecodable treatment item \(control item [^)]*: safety_release_cause string "BOGUS"; expected one of /u,
    );
    assert.equal(harness.state.transitionsSeen().length, 1);
    assert.equal(
      harness.state.treatmentReadCount(),
      BARRIER_TIMING.safety_release_ms / BARRIER_TIMING.poll_interval_ms + 1,
    );
    assert.deepEqual(eventTypes(harness), []);
    assert.equal(field(harness.store.peek('control', TREATMENT_KEY), 'state'), 'TIMEOUT_SIGNALLED');
    const [firstLog] = harness.logs.lines();
    assert.ok(firstLog?.event === 'treatment_read_failed');
    assert.equal(firstLog.code, 'UndecodableItem');
    assert.match(firstLog.detail, /safety_release_cause string "BOGUS"/u);
  });

  it('decides from the superseding item without another read', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID });
    harness.state.interposeBeforeTransition(() => cleanup(harness, 'TIMEOUT_SIGNALLED'));
    const running = await startBarrier(harness);
    assert.deepEqual(await running.result, { kind: 'externally_released', cause: 'CLEANUP_REQUEST' });
    assert.equal(harness.state.treatmentReadCount(), 1);
    assert.equal(harness.state.transitionsSeen().length, 1);
  });

  it('attempts at most one transition per poll interval while transitions keep failing', async () => {
    const harness = stateHarness();
    seedWait(harness, 'TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      harness.store.scriptWriteFault(
        { kind: 'definitive_failure', code: 'InternalServerError' },
        { operation: 'transact' },
      );
    }
    const running = await startBarrier(harness);
    for (let window = 1; window <= 3; window += 1) {
      assert.equal(harness.state.transitionsSeen().length, window);
      await harness.time.advanceBy(BARRIER_TIMING.poll_interval_ms - 1);
      assert.equal(harness.state.transitionsSeen().length, window);
      await harness.time.advanceBy(1);
    }
    assert.deepEqual(await running.result, { kind: 'released' });
    assert.equal(harness.state.transitionsSeen().length, 5);
    assert.equal(harness.state.treatmentReadCount(), 4);
  });
});
