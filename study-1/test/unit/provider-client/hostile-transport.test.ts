// Regressions of WP-06 review round 1 at the boundary where the defects occurred: one whole
// attempt through ProviderClient on virtual time. After the dispatch boundary is crossed the
// attempt always resolves to an outcome and journals it in bounded time, whatever the
// transport does:
// - a 20 KB payload nested 10,000 deep is FAILED/MALFORMED_RESPONSE (design §9.9), not a thrown
//   RangeError with no attempt_outcome_recorded;
// - a rejection with a non-stringifiable value is a transport error at its own time, not a
//   timer win at 3 s plus an unhandled rejection;
// - a transport that ignores the abort and never settles (RK-04) cannot hold back TIMED_OUT,
//   which depends only on the durable caller_timeout_recorded (BR-RUA-023);
// - an outsized offending value is repeated bounded, so the outcome event stays storable.

import assert from 'node:assert/strict';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { describe, it } from 'node:test';

import type { JournalEvent } from '../../../src/event-journal/journal-event.ts';
import { UNREPRESENTABLE_THROWN_NAME } from '../../../src/provider-client/provider-invocation-port.ts';
import {
  attemptInput,
  clientHarness,
  invokeResponse,
  journalEvents,
  MS,
  onlyEvent,
  recordingHarness,
  settleAttempt,
} from '../../support/provider-client/provider-client-fixtures.ts';
import type { ClientHarness } from '../../support/provider-client/provider-client-fixtures.ts';

const SECOND = 1_000n * MS;

function recordTypes(events: readonly JournalEvent[]): readonly string[] {
  return events.map((event) => event.record_type);
}

function deepPayload(depth: number): Uint8Array {
  return new TextEncoder().encode(`${'['.repeat(depth)}${']'.repeat(depth)}`);
}

// Drives an attempt by explicit virtual-time steps, so the test can see when it resolves.
async function attemptPending(harness: ClientHarness): Promise<{ readonly finished: () => boolean }> {
  const state = { done: false };
  void harness.client
    .performAttempt(attemptInput())
    .catch(() => undefined)
    .finally(() => {
      state.done = true;
    });
  await nextMacrotask();
  return { finished: () => state.done };
}

describe('ProviderClient with a hostile transport', () => {
  it('a payload nested 10,000 deep is FAILED/MALFORMED_RESPONSE with its outcome journaled', async () => {
    const harness = clientHarness();
    harness.invoker.resolveAfter(100n * MS, () => invokeResponse(deepPayload(10_000)));
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.dispatch_state, 'DISPATCHED');
    assert.deepEqual(report.failure, {
      code: 'MALFORMED_RESPONSE',
      subject: 'BR-RUA-018',
      detail: 'payload an array of length 1; expected a JSON object',
    });
    const events = journalEvents(harness);
    assert.deepEqual(recordTypes(events), ['attempt_registered', 'dispatch_started', 'attempt_outcome_recorded']);
    assert.equal(report.outcome_event_id, onlyEvent(events, 'attempt_outcome_recorded').event_id);
  });

  it('a payload nested 1,000,000 deep (about 2 MB) is still MALFORMED_RESPONSE', async () => {
    const harness = clientHarness();
    harness.invoker.resolveAfter(100n * MS, () => invokeResponse(deepPayload(1_000_000)));
    const report = await settleAttempt(harness);
    assert.equal(report.failure?.code, 'MALFORMED_RESPONSE');
    assert.equal(onlyEvent(journalEvents(harness), 'attempt_outcome_recorded').outcome, 'FAILED');
  });

  it('a rejection with a null-prototype value is a transport error at 100 ms, never a timeout', async () => {
    const harness = recordingHarness();
    harness.invoker.rejectAfter(100n * MS, Object.create(null));
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.dispatch_state, 'DISPATCHED');
    assert.deepEqual(report.failure, {
      code: 'TRANSPORT_ERROR',
      subject: 'BR-RUA-053',
      detail: `transport_error:${UNREPRESENTABLE_THROWN_NAME}: the thrown value has no readable name or string form; expected a provider response`,
    });
    assert.equal(report.dispatch_to_settlement_ns, '100000000');
    assert.deepEqual(recordTypes(journalEvents(harness)), [
      'attempt_registered',
      'dispatch_started',
      'attempt_outcome_recorded',
    ]);
    assert.equal(harness.time.pendingTimerCount(), 0);
  });

  it('a transport that ignores the abort and never settles still gives TIMED_OUT at 3 s + 2 s', async () => {
    const harness = clientHarness();
    harness.invoker.ignoreAbortForever();
    const attempt = await attemptPending(harness);
    await harness.time.advanceBy(4_999);
    await nextMacrotask();
    // The timeout is durable at 3 s; the client waits out the 2 s grace for a late settlement.
    assert.equal(attempt.finished(), false);
    assert.deepEqual(recordTypes(journalEvents(harness)), [
      'attempt_registered',
      'dispatch_started',
      'caller_timeout_recorded',
    ]);
    await harness.time.advanceBy(1);
    await nextMacrotask();
    assert.equal(attempt.finished(), true);
    const events = journalEvents(harness);
    assert.deepEqual(recordTypes(events), [
      'attempt_registered',
      'dispatch_started',
      'caller_timeout_recorded',
      'attempt_outcome_recorded',
    ]);
    const outcome = onlyEvent(events, 'attempt_outcome_recorded');
    assert.equal(outcome.outcome, 'TIMED_OUT');
    assert.equal(outcome.dispatch_state, 'DISPATCHED');
    assert.equal(outcome.dispatch_to_settlement_ns, '3000000000');
    assert.equal(outcome.occurred_at, '2026-10-05T12:00:05.000Z');
    assert.deepEqual(outcome.causation_event_ids, [onlyEvent(events, 'caller_timeout_recorded').event_id]);
    assert.equal(harness.time.pendingTimerCount(), 0);
  });

  it('a late settlement inside the grace is recorded before the outcome', async () => {
    const harness = clientHarness();
    harness.invoker.resolveAfterAbort(1_999n * MS, () => invokeResponse(new Uint8Array()));
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'TIMED_OUT');
    const events = journalEvents(harness);
    assert.deepEqual(recordTypes(events).slice(2), [
      'caller_timeout_recorded',
      'transport_settled_after_timeout',
      'attempt_outcome_recorded',
    ]);
    const late = onlyEvent(events, 'transport_settled_after_timeout');
    assert.equal(late.settlement_kind, 'resolved');
    assert.equal(late.observed_after_elapsed_ns, '4999000000');
  });

  it('a late settlement after the grace is never recorded', async () => {
    const harness = clientHarness();
    harness.invoker.resolveAfterAbort(2_001n * MS, () => invokeResponse(new Uint8Array()));
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'TIMED_OUT');
    assert.deepEqual(recordTypes(journalEvents(harness)).slice(2), [
      'caller_timeout_recorded',
      'attempt_outcome_recorded',
    ]);
  });

  it('a failed timeout append does not wait for a transport that never settles', async () => {
    const harness = recordingHarness();
    harness.invoker.ignoreAbortForever();
    harness.port.throwNext(new Error('connection reset'));
    const attempt = await attemptPending(harness);
    await harness.time.advanceBy(3_000);
    await nextMacrotask();
    assert.equal(attempt.finished(), true);
    assert.equal(harness.time.pendingTimerCount(), 0);
    const attempted = harness.port.entries().map((entry) => entry.event.record_type);
    assert.deepEqual(attempted, ['caller_timeout_recorded']);
  });

  it('an outsized function error is repeated bounded in the journaled failure detail', async () => {
    const harness = clientHarness();
    const huge = 'E'.repeat(500_000);
    harness.invoker.resolveAfter(SECOND, () => ({ ...invokeResponse(new Uint8Array()), function_error: huge }));
    const report = await settleAttempt(harness);
    const outcome = onlyEvent(journalEvents(harness), 'attempt_outcome_recorded');
    assert.equal(report.failure?.code, 'FUNCTION_ERROR');
    assert.equal(
      outcome.outcome === 'FAILED' ? outcome.failure.detail : '',
      `function error "${'E'.repeat(255)}... (500002 chars); expected none`,
    );
  });
});
