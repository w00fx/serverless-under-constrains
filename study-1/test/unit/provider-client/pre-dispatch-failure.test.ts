// AC-RUA-015 (BR-RUA-021): an attempt that fails before dispatch is NOT_DISPATCHED only when a
// conditional durable transition proves it remained pre-dispatch, and a first action then keeps
// effect knowledge NOT_ATTEMPTED (BR-RUA-022). The durable-transition double is the
// RecordingAttemptStatePort (design §14 row 015). Without the applied transition, absence of
// dispatch proves nothing, so the dispatch state is UNKNOWN.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { foldEffectKnowledge, nextEffectKnowledge } from '../../../src/attempt-lifecycle/effect-knowledge.ts';
import { executionLevelScope, PROBE } from '../../support/event-journal/journal-fixtures.ts';
import {
  attemptInput,
  CAUSE_EVENT_ID,
  FIRST_ATTEMPT_ID,
  FIRST_PROVIDER_REQUEST_ID,
  journalEvents,
  onlyEvent,
  recordingHarness,
  settleAttempt,
} from '../../support/provider-client/provider-client-fixtures.ts';

// A probe caller inside a run's trial partition: no valid provider_refund_call exists (D-06).
const UNBUILDABLE_INPUT = attemptInput({ caller_id: 'probe' });

describe('AC-RUA-015 proven pre-dispatch failure', () => {
  it('ac015-failure-before-dispatch: the conditional NOT_DISPATCHED transition is recorded', async () => {
    const harness = recordingHarness();
    const report = await settleAttempt(harness, UNBUILDABLE_INPUT);

    assert.deepEqual(
      harness.recorder.calls().map(({ operation, event_type, outcome }) => ({ operation, event_type, outcome })),
      [
        { operation: 'registerPreDispatch', event_type: 'attempt_registered', outcome: { kind: 'applied' } },
        { operation: 'transitionToNotDispatched', event_type: 'attempt_not_dispatched', outcome: { kind: 'applied' } },
      ],
    );
    assert.equal(harness.recorder.phaseOf(FIRST_ATTEMPT_ID), 'NOT_DISPATCHED');
    assert.equal(harness.invoker.invocations().length, 0);
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.dispatch_state, 'NOT_DISPATCHED');
    assert.equal(report.outcome_class, 'PRE_DISPATCH_FAILURE');
    assert.equal(report.failure?.code, 'CALL_BUILD_FAILED');
    assert.equal(report.dispatch_to_settlement_ns, undefined);
    // A first action that failed before dispatch keeps NOT_ATTEMPTED (BR-RUA-022 table, row 1).
    assert.equal(nextEffectKnowledge('NOT_ATTEMPTED', report.outcome_class), 'NOT_ATTEMPTED');
    assert.equal(foldEffectKnowledge([report.outcome_class]), 'NOT_ATTEMPTED');
  });

  it('records attempt_registered, attempt_not_dispatched and the outcome as one causal chain', async () => {
    const harness = recordingHarness();
    const report = await settleAttempt(harness, UNBUILDABLE_INPUT);
    const events = journalEvents(harness);
    assert.deepEqual(
      events.map((event) => [event.source_sequence, event.record_type]),
      [
        [1, 'attempt_registered'],
        [2, 'attempt_not_dispatched'],
        [3, 'attempt_outcome_recorded'],
      ],
    );
    const registered = onlyEvent(events, 'attempt_registered');
    const notDispatched = onlyEvent(events, 'attempt_not_dispatched');
    const outcome = onlyEvent(events, 'attempt_outcome_recorded');
    assert.deepEqual(registered.causation_event_ids, [CAUSE_EVENT_ID]);
    assert.deepEqual(notDispatched.causation_event_ids, [registered.event_id]);
    assert.equal(notDispatched.attempt_id, FIRST_ATTEMPT_ID);
    assert.equal(notDispatched.provider_request_id, FIRST_PROVIDER_REQUEST_ID);
    assert.deepEqual(notDispatched.failure, {
      code: 'CALL_BUILD_FAILED',
      subject: 'BR-RUA-021',
      detail:
        'caller probe in a RUN execution with partition trial; expected a TRANSPORT_PROBE execution in the probe partition',
    });
    assert.deepEqual(outcome.causation_event_ids, [notDispatched.event_id]);
    assert.equal(outcome.outcome, 'FAILED');
    assert.equal(outcome.dispatch_state, 'NOT_DISPATCHED');
    assert.equal('dispatch_to_settlement_ns' in outcome, false);
    assert.equal(report.outcome_event_id, outcome.event_id);
  });

  it('a variant caller in the probe partition cannot build a call either', async () => {
    const harness = recordingHarness({ scope: executionLevelScope(PROBE, 'probe'), source: 'probe_caller' });
    const report = await settleAttempt(harness, attemptInput({ caller_id: 'durable' }));
    assert.equal(report.dispatch_state, 'NOT_DISPATCHED');
    assert.deepEqual(report.failure, {
      code: 'CALL_BUILD_FAILED',
      subject: 'BR-RUA-021',
      detail:
        'caller durable in a TRANSPORT_PROBE execution with partition probe; expected a RUN or VARIANT_VALIDATION execution in a trial partition',
    });
  });

  it('without the applied transition the failure is FAILED/UNKNOWN: absence proves nothing', async () => {
    for (const fault of [
      { kind: 'ambiguous', code: 'RequestTimeout', applied: false },
      { kind: 'definitive_failure', code: 'ThrottlingException' },
      { kind: 'condition_failed' },
    ] as const) {
      const harness = recordingHarness();
      harness.recorder.scriptNext('transitionToNotDispatched', fault);
      const report = await settleAttempt(harness, UNBUILDABLE_INPUT);
      assert.equal(report.outcome, 'FAILED', fault.kind);
      assert.equal(report.dispatch_state, 'UNKNOWN', fault.kind);
      assert.equal(report.outcome_class, 'AMBIGUOUS', fault.kind);
      assert.equal(report.failure?.code, 'CALL_BUILD_FAILED', fault.kind);
      assert.equal(harness.invoker.invocations().length, 0, fault.kind);
      assert.equal(foldEffectKnowledge([report.outcome_class]), 'UNKNOWN', fault.kind);
    }
  });

  it('records the UNKNOWN outcome caused by the registration when the transition was refused', async () => {
    const harness = recordingHarness();
    harness.recorder.scriptNext('transitionToNotDispatched', {
      kind: 'definitive_failure',
      code: 'ThrottlingException',
    });
    const report = await settleAttempt(harness, UNBUILDABLE_INPUT);
    const events = journalEvents(harness);
    assert.deepEqual(
      events.map((event) => event.record_type),
      ['attempt_registered', 'attempt_outcome_recorded'],
    );
    const outcome = onlyEvent(events, 'attempt_outcome_recorded');
    assert.deepEqual(outcome.causation_event_ids, [onlyEvent(events, 'attempt_registered').event_id]);
    assert.equal(outcome.dispatch_state, 'UNKNOWN');
    assert.equal(outcome.source_sequence, 2);
    assert.equal(report.outcome_event_id, outcome.event_id);
  });

  it('an ambiguous transition stops the journal, so the UNKNOWN outcome cannot be recorded', async () => {
    const harness = recordingHarness();
    harness.recorder.scriptNext('transitionToNotDispatched', {
      kind: 'ambiguous',
      code: 'RequestTimeout',
      applied: true,
    });
    const report = await settleAttempt(harness, UNBUILDABLE_INPUT);
    assert.equal(report.dispatch_state, 'UNKNOWN');
    assert.equal(report.outcome_event_id, undefined);
    assert.equal(harness.journal.isStopped(), true);
  });

  it('a definitively rejected dispatch transition is proven pre-dispatch by the NOT_DISPATCHED transition', async () => {
    const harness = recordingHarness();
    harness.recorder.scriptNext('transitionToDispatched', { kind: 'definitive_failure', code: 'ValidationException' });
    const report = await settleAttempt(harness);
    assert.equal(harness.invoker.invocations().length, 0);
    assert.equal(harness.recorder.phaseOf(FIRST_ATTEMPT_ID), 'NOT_DISPATCHED');
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.dispatch_state, 'NOT_DISPATCHED');
    assert.equal(report.outcome_class, 'PRE_DISPATCH_FAILURE');
    assert.deepEqual(report.failure, {
      code: 'DISPATCH_TRANSITION_REJECTED',
      subject: 'BR-RUA-021',
      detail: `the dispatch_started transition of attempt ${FIRST_ATTEMPT_ID} was definitively rejected by the store; expected it to apply before any transport call`,
    });
    const events = journalEvents(harness);
    assert.deepEqual(
      events.map((event) => event.record_type),
      ['attempt_registered', 'attempt_not_dispatched', 'attempt_outcome_recorded'],
    );
    // The rejected dispatch_started left no event; its sequence went to attempt_not_dispatched.
    assert.equal(onlyEvent(events, 'attempt_not_dispatched').source_sequence, 2);
  });
});
