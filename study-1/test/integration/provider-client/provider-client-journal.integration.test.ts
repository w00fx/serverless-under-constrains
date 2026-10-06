// Whole attempts over the durable attempt-state port and the caller-journal table (design §5.3
// C1-C6, §9.3; BR-RUA-021, BR-RUA-023, BR-RUA-033): every event the client writes goes through
// the serialization kernel to bytes and back and conforms to its real record schema, the events
// form one causal chain in dense source order, and the attempt-state item ends in the phase the
// outcome claims, in the same partition as the events.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JournalEvent } from '../../../src/event-journal/journal-event.ts';
import { attemptStateSortKey } from '../../../src/provider-client/attempt-state-port.ts';
import { ATTEMPT_STATE_TABLE } from '../../../src/provider-client/durable-attempt-state-port.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { executionLevelScope, PROBE } from '../../support/event-journal/journal-fixtures.ts';
import type { ClientHarness } from '../../support/provider-client/provider-client-fixtures.ts';
import {
  attemptInput,
  CAUSE_EVENT_ID,
  clientHarness,
  FIRST_ATTEMPT_ID,
  invokeResponse,
  journalEvents,
  jsonBytes,
  MS,
  rejectedResponder,
  settleAttempt,
  succeededResponder,
} from '../../support/provider-client/provider-client-fixtures.ts';

const validator = createRecordValidator();

function assertEventsConform(events: readonly JournalEvent[]): void {
  for (const event of events) {
    const parsed = parseJsonDocument(serializeRecordFile(event));
    assert.ok(parsed.ok, event.record_type);
    const validation = validator.validateAs(event.record_type, parsed.value);
    assert.equal(validation.valid, true, `${event.record_type}: ${JSON.stringify(validation)}`);
  }
}

// Events are dense in source order and each is caused by the event at `causeIndexes[i]`, or by
// the caller's own cause at -1. By default each event is caused by the one before it.
function assertCausalChain(events: readonly JournalEvent[], causeIndexes = events.map((_, index) => index - 1)): void {
  events.forEach((event, index) => {
    assert.equal(event.source_sequence, index + 1);
    const causeIndex = causeIndexes[index] ?? -1;
    const cause = causeIndex === -1 ? CAUSE_EVENT_ID : events[causeIndex]?.event_id;
    assert.deepEqual(event.causation_event_ids, [cause], event.record_type);
  });
}

function attemptPhase(harness: ClientHarness, events: readonly JournalEvent[]): unknown {
  const pk =
    harness.store.itemsIn(ATTEMPT_STATE_TABLE).find((item) => item['event_id'] === events[0]?.event_id)?.pk ?? '';
  return harness.store.peek(ATTEMPT_STATE_TABLE, { pk, sk: attemptStateSortKey(FIRST_ATTEMPT_ID) })?.['phase'];
}

describe('ProviderClient over the caller journal', () => {
  it('a SUCCEEDED attempt journals registration, dispatch and outcome; the state is DISPATCHED', async () => {
    const harness = clientHarness();
    harness.invoker.resolveAfter(120n * MS, succeededResponder);
    const report = await settleAttempt(harness);
    const events = journalEvents(harness);
    assert.equal(report.outcome, 'SUCCEEDED');
    assert.deepEqual(
      events.map((event) => event.record_type),
      ['attempt_registered', 'dispatch_started', 'attempt_outcome_recorded'],
    );
    assertEventsConform(events);
    assertCausalChain(events);
    assert.equal(report.outcome_event_id, events[2]?.event_id);
    assert.equal(attemptPhase(harness, events), 'DISPATCHED');
  });

  it('a REJECTED attempt and a FAILED attempt journal schema-valid outcomes', async () => {
    const rejected = clientHarness();
    rejected.invoker.resolveAfter(80n * MS, rejectedResponder('AMOUNT_INVALID'));
    assert.equal((await settleAttempt(rejected)).outcome, 'REJECTED');
    assertEventsConform(journalEvents(rejected));

    const failed = clientHarness();
    failed.invoker.resolveAfter(80n * MS, () => invokeResponse(jsonBytes({ errorType: 'Error' }), '6'));
    const report = await settleAttempt(failed);
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.dispatch_state, 'DISPATCHED');
    assertEventsConform(journalEvents(failed));
    assert.equal(attemptPhase(failed, journalEvents(failed)), 'DISPATCHED');
  });

  it('a TIMED_OUT attempt journals the timeout and the late settlement in causal order', async () => {
    const harness = clientHarness();
    harness.invoker.resolveAfterAbort(400n * MS, succeededResponder);
    const report = await settleAttempt(harness);
    const events = journalEvents(harness);
    assert.equal(report.outcome, 'TIMED_OUT');
    assert.deepEqual(
      events.map((event) => event.record_type),
      [
        'attempt_registered',
        'dispatch_started',
        'caller_timeout_recorded',
        'transport_settled_after_timeout',
        'attempt_outcome_recorded',
      ],
    );
    assertEventsConform(events);
    // The timeout record and the late settlement both answer the dispatch (design §6.2 #24);
    // the outcome rests on the timeout record, the only proof of TIMED_OUT (BR-RUA-023).
    assertCausalChain(events, [-1, 0, 1, 1, 2]);
    assert.equal(attemptPhase(harness, events), 'DISPATCHED');
  });

  it('a call that cannot be built journals attempt_not_dispatched; the state is NOT_DISPATCHED', async () => {
    const harness = clientHarness();
    const report = await settleAttempt(harness, attemptInput({ caller_id: 'probe' }));
    const events = journalEvents(harness);
    assert.equal(report.outcome_class, 'PRE_DISPATCH_FAILURE');
    assert.deepEqual(
      events.map((event) => event.record_type),
      ['attempt_registered', 'attempt_not_dispatched', 'attempt_outcome_recorded'],
    );
    assertEventsConform(events);
    assertCausalChain(events);
    assert.equal(attemptPhase(harness, events), 'NOT_DISPATCHED');
    assert.deepEqual(harness.invoker.invocations(), []);
  });

  it('the probe caller in the probe partition journals schema-valid probe events', async () => {
    const harness = clientHarness({ scope: executionLevelScope(PROBE, 'probe'), source: 'probe_caller' });
    harness.invoker.resolveAfter(30n * MS, succeededResponder);
    const report = await settleAttempt(harness, attemptInput({ caller_id: 'probe' }));
    const events = journalEvents(harness);
    assert.equal(report.outcome, 'SUCCEEDED');
    assert.equal(events.length, 3);
    assertEventsConform(events);
    assert.equal(attemptPhase(harness, events), 'DISPATCHED');
  });

  // Regression (WP-06 review round 2): the raw function error and executed version reached the
  // outcome event unbounded, so a 500,000-character header made the outcome item exceed the
  // 400 KB limit the store enforces, and the dispatched attempt lost its outcome event.
  it('outsized response headers still journal a stored, schema-valid outcome', async () => {
    const outsized = [
      { function_error: 'E'.repeat(500_000), executed_version: '7', code: 'FUNCTION_ERROR' },
      { function_error: undefined, executed_version: '9'.repeat(450_000), code: 'VERSION_MISMATCH' },
    ] as const;
    for (const headers of outsized) {
      const harness = clientHarness();
      harness.invoker.resolveAfter(80n * MS, () => ({
        ...invokeResponse(new Uint8Array(), headers.executed_version),
        function_error: headers.function_error,
      }));
      const report = await settleAttempt(harness);
      const events = journalEvents(harness);
      assert.equal(report.failure?.code, headers.code);
      assert.deepEqual(
        events.map((event) => event.record_type),
        ['attempt_registered', 'dispatch_started', 'attempt_outcome_recorded'],
      );
      const outcome = events[2];
      assert.ok(outcome !== undefined);
      assert.equal(report.outcome_event_id, outcome.event_id);
      assertEventsConform(events);
      assert.ok(serializeRecordFile(outcome).length < 8 * 1024);
    }
  });
});
