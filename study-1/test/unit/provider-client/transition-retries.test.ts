// BR-RUA-033 at the ProviderClient boundary: "A writer ... retries a definitive failed append
// using identical event identity, content, and sequence." The C1-C3 transactions carry journal
// appends, so each one the store definitively refuses is resubmitted with the same reserved put
// within the writer's budget before C1 throws, C2 falls back to UNKNOWN or C3 re-plans.
// Regression (WP-06 review round 2): with the probe caller's budget of 2, one transient
// ThrottlingException made C1 throw AttemptNotRegisteredError, turned a provable NOT_DISPATCHED
// into FAILED/UNKNOWN at C2, and made C3 a pre-dispatch failure instead of a dispatched attempt.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { foldEffectKnowledge } from '../../../src/attempt-lifecycle/effect-knowledge.ts';
import { DeadlineTimer } from '../../../src/provider-client/deadline-timer.ts';
import { AttemptNotRegisteredError, ProviderClient } from '../../../src/provider-client/provider-client.ts';
import type { ProviderClientDeps } from '../../../src/provider-client/provider-client.ts';
import { TRIAL_SCOPE } from '../../support/event-journal/journal-fixtures.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import {
  attemptInput,
  FIRST_ATTEMPT_ID,
  journalEvents,
  MS,
  onlyEvent,
  recordingHarness,
  settleAttempt,
  succeededResponder,
} from '../../support/provider-client/provider-client-fixtures.ts';
import type {
  AttemptOperation,
  RecordedTransition,
} from '../../support/provider-client/recording-attempt-state-port.ts';

const THROTTLED = { kind: 'definitive_failure', code: 'ThrottlingException' } as const;
// A probe caller inside a run's trial partition: no valid provider_refund_call exists (D-06).
const UNBUILDABLE_INPUT = attemptInput({ caller_id: 'probe' });

function callsOf(calls: readonly RecordedTransition[], operation: AttemptOperation): readonly RecordedTransition[] {
  return calls.filter((call) => call.operation === operation);
}

// Every try of one operation carried the very same reserved put: identical event id, content
// and sequence.
function assertIdenticalRetries(tries: readonly RecordedTransition[], count: number): void {
  assert.equal(tries.length, count);
  const first = tries[0];
  assert.ok(first !== undefined);
  for (const retry of tries) {
    assert.equal(retry.put, first.put);
    assert.equal(retry.put.event.event_id, first.put.event.event_id);
    assert.equal(retry.put.event.source_sequence, first.put.event.source_sequence);
  }
}

describe('ProviderClient identical transition retries (BR-RUA-033)', () => {
  it('C1: a refused registration is retried identically and the attempt proceeds', async () => {
    const harness = recordingHarness({ maxDefinitiveRetries: 2 });
    harness.recorder.scriptNext('registerPreDispatch', THROTTLED);
    harness.invoker.resolveAfter(MS, succeededResponder);
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'SUCCEEDED');
    const registrations = callsOf(harness.recorder.calls(), 'registerPreDispatch');
    assertIdenticalRetries(registrations, 2);
    assert.deepEqual(
      registrations.map((call) => call.outcome),
      [THROTTLED, { kind: 'applied' }],
    );
    const registered = onlyEvent(journalEvents(harness), 'attempt_registered');
    assert.equal(registered.event_id, registrations[0]?.put.event.event_id);
    assert.equal(registered.source_sequence, 1);
  });

  it('C1: a registration refused budget + 1 times still throws AttemptNotRegisteredError', async () => {
    const harness = recordingHarness({ maxDefinitiveRetries: 2 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      harness.recorder.scriptNext('registerPreDispatch', THROTTLED);
    }
    await assert.rejects(settleAttempt(harness), (error: unknown) => {
      assert.ok(error instanceof AttemptNotRegisteredError);
      assert.equal(error.registration, 'rejected');
      return true;
    });
    assertIdenticalRetries(callsOf(harness.recorder.calls(), 'registerPreDispatch'), 3);
    assert.equal(harness.invoker.invocations().length, 0);
  });

  it('C2: a refused NOT_DISPATCHED transition is retried and proves NOT_DISPATCHED', async () => {
    const harness = recordingHarness({ maxDefinitiveRetries: 2 });
    harness.recorder.scriptNext('transitionToNotDispatched', THROTTLED);
    harness.recorder.scriptNext('transitionToNotDispatched', THROTTLED);
    const report = await settleAttempt(harness, UNBUILDABLE_INPUT);
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.dispatch_state, 'NOT_DISPATCHED');
    assert.equal(report.outcome_class, 'PRE_DISPATCH_FAILURE');
    assert.equal(foldEffectKnowledge([report.outcome_class]), 'NOT_ATTEMPTED');
    const tries = callsOf(harness.recorder.calls(), 'transitionToNotDispatched');
    assertIdenticalRetries(tries, 3);
    assert.equal(harness.recorder.phaseOf(FIRST_ATTEMPT_ID), 'NOT_DISPATCHED');
    const events = journalEvents(harness);
    assert.deepEqual(
      events.map((event) => [event.source_sequence, event.record_type]),
      [
        [1, 'attempt_registered'],
        [2, 'attempt_not_dispatched'],
        [3, 'attempt_outcome_recorded'],
      ],
    );
    assert.equal(onlyEvent(events, 'attempt_not_dispatched').event_id, tries[0]?.put.event.event_id);
  });

  it('C2: refused budget + 1 times, the dispatch state stays UNKNOWN', async () => {
    const harness = recordingHarness({ maxDefinitiveRetries: 1 });
    harness.recorder.scriptNext('transitionToNotDispatched', THROTTLED);
    harness.recorder.scriptNext('transitionToNotDispatched', THROTTLED);
    const report = await settleAttempt(harness, UNBUILDABLE_INPUT);
    assert.equal(report.dispatch_state, 'UNKNOWN');
    assertIdenticalRetries(callsOf(harness.recorder.calls(), 'transitionToNotDispatched'), 2);
  });

  it('C3: a refused dispatch transition is retried and the transport is then invoked once', async () => {
    const harness = recordingHarness({ maxDefinitiveRetries: 2 });
    harness.recorder.scriptNext('transitionToDispatched', THROTTLED);
    harness.invoker.resolveAfter(MS, succeededResponder);
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'SUCCEEDED');
    assert.equal(report.dispatch_state, 'DISPATCHED');
    assert.equal(harness.invoker.invocations().length, 1);
    const tries = callsOf(harness.recorder.calls(), 'transitionToDispatched');
    assertIdenticalRetries(tries, 2);
    assert.equal(callsOf(harness.recorder.calls(), 'transitionToNotDispatched').length, 0);
    const started = onlyEvent(journalEvents(harness), 'dispatch_started');
    assert.equal(started.event_id, tries[0]?.put.event.event_id);
    assert.equal(started.source_sequence, 2);
  });

  it('C3: refused budget + 1 times, the attempt is proven NOT_DISPATCHED and never invoked', async () => {
    const harness = recordingHarness({ maxDefinitiveRetries: 2 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      harness.recorder.scriptNext('transitionToDispatched', THROTTLED);
    }
    const report = await settleAttempt(harness);
    assert.equal(report.dispatch_state, 'NOT_DISPATCHED');
    assert.equal(report.failure?.code, 'DISPATCH_TRANSITION_REJECTED');
    assert.equal(harness.invoker.invocations().length, 0);
    assertIdenticalRetries(callsOf(harness.recorder.calls(), 'transitionToDispatched'), 3);
  });
});

describe('ProviderClient construction', () => {
  function deps(maxDefinitiveRetries: number): ProviderClientDeps {
    const base = recordingHarness();
    const time = new VirtualTimeScheduler({ wallEpochMs: 0 });
    return {
      invoker: base.invoker,
      attempts: base.attempts,
      journal: base.journal,
      scope: TRIAL_SCOPE,
      monotonic: time,
      wall: time,
      timer: new DeadlineTimer({ monotonic: time, scheduler: time }),
      ids: new SequentialUuidSource('dddddddd'),
      maxDefinitiveRetries,
    };
  }

  it('refuses a retry budget that is not a nonnegative safe integer', () => {
    for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      assert.throws(() => new ProviderClient(deps(invalid)), {
        name: 'RangeError',
        message: `maxDefinitiveRetries ${String(invalid)}; expected a nonnegative safe integer`,
      });
    }
  });

  it('accepts a budget of 0 and of the probe caller (2)', () => {
    for (const valid of [0, 2]) {
      assert.ok(new ProviderClient(deps(valid)) instanceof ProviderClient);
    }
  });
});
