// AC-RUA-044 (BR-RUA-023): an abort error alone never proves a timeout. The attempt is TIMED_OUT
// only when at least 3 s of monotonic time elapsed, the timer won the arbiter while the transport
// was unsettled, the abort was requested, and `caller_timeout_recorded` was durably appended.
// A fake clock (VirtualTimeScheduler) and a fake transport (ScriptedProviderInvoker) drive every
// case (design §14 row 044), plus the RK-03 early timer and the D-26 late settlement.

import assert from 'node:assert/strict';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { describe, it } from 'node:test';

import type { JournalEvent } from '../../../src/event-journal/journal-event.ts';
import type { ProviderTransportResult } from '../../../src/provider-client/provider-invocation-port.ts';
import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  attemptInput,
  clientHarness,
  invokeResponse,
  journalEvents,
  MS,
  onlyEvent,
  PROVIDER_CALL_ID,
  PROVIDER_TRANSACTION_ID,
  recordingHarness,
  settleAttempt,
  succeededResponder,
  transportError,
} from '../../support/provider-client/provider-client-fixtures.ts';
import { ABORTED_SETTLEMENT } from '../../support/provider-client/scripted-provider-invoker.ts';

const SECOND = 1_000n * MS;

function recordTypes(events: readonly JournalEvent[]): readonly string[] {
  return events.map((event) => event.record_type);
}

describe('AC-RUA-044 an abort error alone never proves a timeout', () => {
  it('abort-before-3s: an AbortError at 1 s without a timer win is FAILED/DISPATCHED', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(SECOND, () => ABORTED_SETTLEMENT);
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.dispatch_state, 'DISPATCHED');
    assert.equal(report.outcome_class, 'AMBIGUOUS');
    assert.deepEqual(report.failure, {
      code: 'ABORTED_WITHOUT_DEADLINE',
      subject: 'BR-RUA-023',
      detail:
        'transport aborted (Request aborted) without a deadline timer win; expected an abort only after the timer won',
    });
    assert.equal(report.dispatch_to_settlement_ns, '1000000000');
    const events = journalEvents(harness);
    assert.deepEqual(recordTypes(events), ['attempt_registered', 'dispatch_started', 'attempt_outcome_recorded']);
    // The client never aborted: the timer was cancelled before it could claim.
    assert.equal(harness.invoker.invocations()[0]?.signal.aborted, false);
    assert.equal(harness.time.pendingTimerCount(), 0);
  });

  it('abort-before-3s: an AbortError 1 ns before the deadline is still not a timeout', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(3n * SECOND - 1n, () => ABORTED_SETTLEMENT);
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.failure?.code, 'ABORTED_WITHOUT_DEADLINE');
    assert.equal(report.dispatch_to_settlement_ns, '2999999999');
  });

  it('transport-settles-first: a response at 2.999 s wins and cancels the timer', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(2_999n * MS, succeededResponder);
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'SUCCEEDED');
    assert.equal(report.dispatch_state, 'DISPATCHED');
    assert.equal(report.provider_transaction_id, PROVIDER_TRANSACTION_ID);
    assert.equal(report.dispatch_to_settlement_ns, '2999000000');
    assert.equal(harness.time.pendingTimerCount(), 0);
    assert.deepEqual(recordTypes(journalEvents(harness)), [
      'attempt_registered',
      'dispatch_started',
      'attempt_outcome_recorded',
    ]);
  });

  it('transport-settles-first: a transport error before the deadline is FAILED, never TIMED_OUT', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(2_500n * MS, () => transportError('TooManyRequestsException', 'Rate exceeded', 429));
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'FAILED');
    assert.deepEqual(report.failure, {
      code: 'TRANSPORT_ERROR',
      subject: 'BR-RUA-053',
      detail: 'transport_error:TooManyRequestsException (HTTP 429): Rate exceeded; expected a provider response',
    });
  });

  it('timeout-write-fails: an ambiguous timeout append gives FAILED/DISPATCHED, never TIMED_OUT', async () => {
    const harness = recordingHarness();
    harness.invoker.hang();
    harness.port.throwNext(new Error('connection reset'));
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.dispatch_state, 'DISPATCHED');
    assert.equal(report.outcome_class, 'AMBIGUOUS');
    assert.equal(report.failure?.code, 'TIMEOUT_RECORD_NOT_DURABLE');
    assert.equal(report.failure.subject, 'BR-RUA-023');
    assert.match(report.failure.detail, /not durably appended \(AMBIGUOUS_APPEND\)/u);
    assert.equal(report.dispatch_to_settlement_ns, '3000000000');
    // The abort was requested at the deadline even though the write failed afterwards.
    assert.equal(harness.invoker.invocations()[0]?.signal.aborted, true);
    const attempted = harness.port.entries().map((entry) => entry.event.record_type);
    assert.deepEqual(attempted, ['caller_timeout_recorded']);
    // The instance stopped, so nothing after the failed write reached the journal.
    assert.equal(report.outcome_event_id, undefined);
  });

  it('timeout-write-fails: definitive failures past the retry budget give FAILED/DISPATCHED', async () => {
    const harness = recordingHarness({ maxDefinitiveRetries: 1 });
    harness.invoker.hang();
    harness.store.scriptWriteFault({ kind: 'definitive_failure', code: 'ProvisionedThroughputExceededException' });
    harness.store.scriptWriteFault({ kind: 'definitive_failure', code: 'ProvisionedThroughputExceededException' });
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.failure?.code, 'TIMEOUT_RECORD_NOT_DURABLE');
    assert.match(report.failure.detail, /\(DEFINITIVE_RETRIES_EXHAUSTED\)/u);
    assert.deepEqual(recordTypes(journalEvents(harness)), ['attempt_registered', 'dispatch_started']);
  });

  it('timeout-write-fails: a definitive failure retried within budget still yields TIMED_OUT', async () => {
    const harness = recordingHarness({ maxDefinitiveRetries: 1 });
    harness.invoker.hang();
    harness.store.scriptWriteFault({ kind: 'definitive_failure', code: 'ThrottlingException' });
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'TIMED_OUT');
    assert.equal(report.failure, undefined);
  });

  it('a timer win records the full caller_timeout_recorded and the aborted settlement', async () => {
    const harness = clientHarness();
    harness.invoker.hang();
    const report = await settleAttempt(harness);
    const events = journalEvents(harness);
    assert.deepEqual(recordTypes(events), [
      'attempt_registered',
      'dispatch_started',
      'caller_timeout_recorded',
      'transport_settled_after_timeout',
      'attempt_outcome_recorded',
    ]);
    const dispatchStarted = onlyEvent(events, 'dispatch_started');
    const timeout = onlyEvent(events, 'caller_timeout_recorded');
    assert.deepEqual(
      {
        elapsed_ns: timeout.elapsed_ns,
        monotonic_origin_event_id: timeout.monotonic_origin_event_id,
        dispatch_at: timeout.dispatch_at,
        deadline_at: timeout.deadline_at,
        timer_fired_at: timeout.timer_fired_at,
        abort_requested_at: timeout.abort_requested_at,
        recorded_at: timeout.recorded_at,
        arbiter_winner: timeout.arbiter_winner,
        transport_settled_at_claim: timeout.transport_settled_at_claim,
        causation_event_ids: timeout.causation_event_ids,
        attempt_id: timeout.attempt_id,
        refund_request_id: timeout.refund_request_id,
      },
      {
        elapsed_ns: '3000000000',
        monotonic_origin_event_id: dispatchStarted.event_id,
        dispatch_at: '2026-10-05T12:00:00.000Z',
        deadline_at: '2026-10-05T12:00:03.000Z',
        timer_fired_at: '2026-10-05T12:00:03.000Z',
        abort_requested_at: '2026-10-05T12:00:03.000Z',
        recorded_at: '2026-10-05T12:00:03.000Z',
        arbiter_winner: 'TIMER',
        transport_settled_at_claim: false,
        causation_event_ids: [dispatchStarted.event_id],
        attempt_id: report.attempt_id,
        refund_request_id: 'ref-poc-001',
      },
    );
    const late = onlyEvent(events, 'transport_settled_after_timeout');
    assert.equal(late.settlement_kind, 'aborted');
    assert.equal(late.observed_after_elapsed_ns, '3000000000');
    assert.deepEqual(late.causation_event_ids, [dispatchStarted.event_id]);
    const outcome = onlyEvent(events, 'attempt_outcome_recorded');
    assert.equal(outcome.outcome, 'TIMED_OUT');
    assert.equal(outcome.dispatch_state, 'DISPATCHED');
    assert.equal(outcome.dispatch_to_settlement_ns, '3000000000');
    assert.deepEqual(outcome.causation_event_ids, [timeout.event_id]);
    assert.equal(report.outcome, 'TIMED_OUT');
    assert.equal(report.outcome_class, 'AMBIGUOUS');
    assert.equal(report.outcome_event_id, outcome.event_id);
  });

  it('a transport due exactly at the deadline loses to the timer, which was armed first', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(3n * SECOND, succeededResponder);
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'TIMED_OUT');
    assert.equal(onlyEvent(journalEvents(harness), 'transport_settled_after_timeout').settlement_kind, 'aborted');
  });

  it('early-timer-fire-rearms: a firing 2 ms early re-arms and claims at exactly 3 s', async () => {
    const harness = recordingHarness();
    harness.invoker.hang();
    harness.time.fireEarlyBy(2n * MS);
    const pending = harness.client.performAttempt(attemptInput());
    await nextMacrotask();
    await harness.time.advanceBy(2_998);
    // The early firing found 2.998 s elapsed: no claim, no abort, one re-armed timer.
    assert.equal(harness.invoker.invocations()[0]?.signal.aborted, false);
    assert.equal(harness.time.pendingTimerCount(), 1);
    assert.deepEqual(recordTypes(journalEvents(harness)), ['attempt_registered', 'dispatch_started']);
    await harness.time.advanceBy(2);
    const report = await pending;
    assert.equal(report.outcome, 'TIMED_OUT');
    const timeout = onlyEvent(journalEvents(harness), 'caller_timeout_recorded');
    assert.equal(timeout.elapsed_ns, '3000000000');
    assert.equal(timeout.timer_fired_at, '2026-10-05T12:00:03.000Z');
  });

  it('early-timer-fire-rearms: a firing 1 ns early re-arms for one rounded-up millisecond', async () => {
    const harness = recordingHarness();
    harness.invoker.hang();
    harness.time.fireEarlyBy(1n);
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'TIMED_OUT');
    assert.equal(report.dispatch_to_settlement_ns, '3000999999');
    assert.equal(onlyEvent(journalEvents(harness), 'caller_timeout_recorded').elapsed_ns, '3000999999');
  });

  it('late-settlement-not-parsed: a success arriving after the timer won is recorded, never parsed', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfterAbort(500n * MS, succeededResponder);
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'TIMED_OUT');
    assert.equal(report.provider_call_id, undefined);
    assert.equal(report.provider_transaction_id, undefined);
    const events = journalEvents(harness);
    const late = onlyEvent(events, 'transport_settled_after_timeout');
    assert.equal(late.settlement_kind, 'resolved');
    assert.equal(late.observed_after_elapsed_ns, '3500000000');
    // BR-RUA-015: no caller event carries the success or the provider's identities.
    for (const event of events) {
      const text = canonicalJson(event as unknown as JsonValue);
      assert.equal(text.includes(PROVIDER_TRANSACTION_ID), false, event.record_type);
      assert.equal(text.includes(PROVIDER_CALL_ID), false, event.record_type);
      assert.equal(text.includes('SUCCEEDED'), false, event.record_type);
    }
  });

  it('late-settlement-not-parsed: unparseable late bytes and late errors never change TIMED_OUT', async () => {
    const cases = [
      { respond: (): ProviderTransportResult => invokeResponse(Uint8Array.of(0xff, 0xfe)), kind: 'resolved' },
      { respond: (): ProviderTransportResult => transportError('ServiceException', 'internal'), kind: 'rejected' },
    ] as const;
    for (const { respond, kind } of cases) {
      const harness = recordingHarness();
      harness.invoker.resolveAfterAbort(10n * MS, respond);
      const report = await settleAttempt(harness);
      assert.equal(report.outcome, 'TIMED_OUT', kind);
      assert.equal(report.failure, undefined, kind);
      const late = onlyEvent(journalEvents(harness), 'transport_settled_after_timeout');
      assert.equal(late.settlement_kind, kind);
      assert.equal(late.observed_after_elapsed_ns, '3010000000');
    }
  });
});
