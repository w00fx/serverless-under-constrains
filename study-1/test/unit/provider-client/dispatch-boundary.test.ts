// AC-RUA-028 (BR-RUA-021), provider-client half: the transport is invoked only after the
// `dispatch_started` transition applied, never after an unapplied one, and once the boundary is
// crossed the attempt stays conservatively DISPATCHED whatever the transport does. A dispatch
// transition that did not apply leaves the boundary unlocatable: FAILED with UNKNOWN dispatch,
// which BR-RUA-004 makes ambiguous (knowledge UNKNOWN).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { foldEffectKnowledge } from '../../../src/attempt-lifecycle/effect-knowledge.ts';
import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import {
  attemptInput,
  FIRST_ATTEMPT_ID,
  journalEvents,
  MONOTONIC_ORIGIN_NS,
  onlyEvent,
  recordingHarness,
  settleAttempt,
  succeededResponder,
} from '../../support/provider-client/provider-client-fixtures.ts';
import type { ScriptedTransitionFault } from '../../support/provider-client/recording-attempt-state-port.ts';

describe('AC-RUA-028 dispatch boundary in the shared provider client', () => {
  it('ambiguous-dispatch-transition-never-invokes-transport', async () => {
    for (const applied of [false, true]) {
      const harness = recordingHarness();
      harness.invoker.resolveAfter(100n, succeededResponder);
      harness.recorder.scriptNext('transitionToDispatched', { kind: 'ambiguous', code: 'RequestTimeout', applied });
      const report = await settleAttempt(harness);

      assert.equal(harness.invoker.invocations().length, 0, `applied=${String(applied)}`);
      assert.equal(harness.invoker.pendingScriptCount(), 1);
      assert.equal(report.outcome, 'FAILED');
      assert.equal(report.dispatch_state, 'UNKNOWN');
      assert.equal(report.outcome_class, 'AMBIGUOUS');
      assert.deepEqual(report.failure, {
        code: 'DISPATCH_TRANSITION_AMBIGUOUS',
        subject: 'BR-RUA-021',
        detail:
          'the dispatch_started transition ended ambiguous; expected applied before any transport call, so the transport was not invoked',
      });
      assert.equal(report.dispatch_to_settlement_ns, undefined);
      // The journal instance stopped (BR-RUA-033), so no outcome event exists.
      assert.equal(report.outcome_event_id, undefined);
      assert.equal(harness.journal.isStopped(), true);
      assert.equal(foldEffectKnowledge([report.outcome_class]), 'UNKNOWN');
    }
  });

  it('a dispatch transition whose condition failed never invokes the transport', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(100n, succeededResponder);
    harness.recorder.scriptNext('transitionToDispatched', { kind: 'condition_failed' });
    const report = await settleAttempt(harness);
    assert.equal(harness.invoker.invocations().length, 0);
    assert.equal(report.dispatch_state, 'UNKNOWN');
    assert.equal(report.failure?.code, 'DISPATCH_TRANSITION_CONDITION_FAILED');
    assert.equal(
      report.failure.detail,
      'the dispatch_started transition ended condition_failed; expected applied before any transport call, so the transport was not invoked',
    );
    const events = journalEvents(harness);
    assert.deepEqual(
      events.map((event) => event.record_type),
      ['attempt_registered', 'attempt_outcome_recorded'],
    );
    assert.equal(report.outcome_event_id, onlyEvent(events, 'attempt_outcome_recorded').event_id);
  });

  it('another event at the dispatch event key is a condition failure, and the instance stops', async () => {
    const harness = recordingHarness();
    harness.recorder.scriptNext('transitionToDispatched', {
      kind: 'condition_failed',
      existing: foreignItemAtSequence2(),
    });
    const report = await settleAttempt(harness);
    assert.equal(harness.invoker.invocations().length, 0);
    assert.equal(report.failure?.code, 'DISPATCH_TRANSITION_CONDITION_FAILED');
    assert.equal(report.outcome_event_id, undefined);
    assert.equal(harness.journal.isStopped(), true);
  });

  it('an attempt-state port that throws counts as ambiguous and never invokes the transport', async () => {
    const harness = recordingHarness();
    const fault: ScriptedTransitionFault = { kind: 'throw', error: new TypeError('socket closed') };
    harness.recorder.scriptNext('transitionToDispatched', fault);
    const report = await settleAttempt(harness);
    assert.equal(harness.invoker.invocations().length, 0);
    assert.equal(report.failure?.code, 'DISPATCH_TRANSITION_AMBIGUOUS');
    assert.deepEqual(harness.recorder.calls().at(-1)?.outcome, { kind: 'thrown' });
  });

  it('invokes the transport only after the applied transition, at the monotonic origin', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(250n * 1_000_000n, succeededResponder);
    const report = await settleAttempt(harness);
    const [invocation] = harness.invoker.invocations();
    assert.ok(invocation !== undefined);
    assert.equal(harness.recorder.phaseOf(FIRST_ATTEMPT_ID), 'DISPATCHED');
    assert.equal(invocation.invoked_at_ns, MONOTONIC_ORIGIN_NS);
    assert.equal(invocation.call.attempt_id, FIRST_ATTEMPT_ID);
    const events = journalEvents(harness);
    const dispatchStarted = onlyEvent(events, 'dispatch_started');
    assert.deepEqual(dispatchStarted.causation_event_ids, [onlyEvent(events, 'attempt_registered').event_id]);
    assert.equal(dispatchStarted.dispatch_at, '2026-10-05T12:00:00.000Z');
    assert.equal(dispatchStarted.deadline_at, '2026-10-05T12:00:03.000Z');
    assert.equal(dispatchStarted.deadline_ns, '3000000000');
    assert.equal(report.outcome, 'SUCCEEDED');
    assert.equal(report.dispatch_to_settlement_ns, '250000000');
  });

  it('transport-thrown-after-boundary: a transport that throws before sending stays DISPATCHED', async () => {
    const harness = recordingHarness();
    harness.invoker.throwBeforeSend(new RangeError('Invalid payload'));
    const report = await settleAttempt(harness, attemptInput());
    assert.equal(harness.invoker.invocations().length, 1);
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.dispatch_state, 'DISPATCHED');
    assert.equal(report.outcome_class, 'AMBIGUOUS');
    assert.deepEqual(report.failure, {
      code: 'TRANSPORT_ERROR',
      subject: 'BR-RUA-053',
      detail: 'transport_error:"RangeError": "Invalid payload"; expected a provider response',
    });
    assert.equal(report.dispatch_to_settlement_ns, '0');
  });
});

// A different event already stored at this instance's sequence 2, the key the dispatch event
// reserves (`classifyJournalOutcome` reads it as a sequence conflict).
function foreignItemAtSequence2(): StoredItem {
  return {
    pk: 'aaaaaaaa-0000-4000-8000-000000000001#bbbbbbbb-0000-4000-8000-000000000001',
    sk: 'conventional_caller#cccccccc-0000-4000-8000-000000000001#000000000002',
    record_type: 'caller_invocation_started',
  };
}
