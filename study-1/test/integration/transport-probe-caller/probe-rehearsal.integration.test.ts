// AC-RUA-002 supplementary offline rehearsal (design §12.3, §14 row 002; WP-08). The real provider,
// controller and probe caller run under one virtual clock over the store and stream emulators:
// readiness canary, provider warm-up, then the single probe invocation. The assertions restate
// BR-RUA-010..015 from the spec text; the verdict itself is the oracle's (golden
// `ac002-condition-derivation`, WP-10), not this test's.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { JournalEvent } from '../../../src/event-journal/journal-event.ts';
import { parseJsonl } from '../../../src/record-contract/parsing.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { PROBE_PK } from '../../unit/refund-provider/support/provider-fixtures.ts';
import {
  collectProbeEvidence,
  evidenceViolations,
  recordsOf,
  writeProbeEvidence,
} from '../../support/transport-rehearsal/rehearsal-evidence.ts';
import { CANARY_PK, TransportRehearsal, WARMUP_PK } from '../../support/transport-rehearsal/transport-rehearsal.ts';

const validator = createRecordValidator();

function value(event: JournalEvent | undefined, name: string): unknown {
  return (event as unknown as Readonly<Record<string, unknown>>)[name];
}

function only(events: readonly JournalEvent[], type: string): JournalEvent {
  const matching = events.filter((event) => event.record_type === type);
  assert.equal(matching.length, 1, `${String(matching.length)} ${type} event(s); expected exactly one`);
  const [first] = matching;
  assert.ok(first !== undefined);
  return first;
}

function types(events: readonly JournalEvent[]): readonly string[] {
  return events.map((event) => event.record_type);
}

describe('AC-RUA-002 offline transport rehearsal', () => {
  it('ac002-rehearsal-sequence: canary acknowledged, then one warm-up, then the single probe invocation', async () => {
    const rehearsal = new TransportRehearsal();
    rehearsal.seedProbePartition();
    const ack = await rehearsal.acknowledgeCanary();
    const [canary] = rehearsal.events('caller_journal', CANARY_PK);
    assert.equal(value(ack, 'canary_event_id'), canary?.event_id);
    assert.deepEqual(ack.causation_event_ids, [canary?.event_id]);
    assert.deepEqual(rehearsal.events('experiment_journal', WARMUP_PK), []);

    const warm = await rehearsal.warmUpProvider();
    assert.equal(warm.record_type, 'provider_warmup_completed');
    assert.deepEqual(types(rehearsal.events('experiment_journal', WARMUP_PK)), ['provider_warmup_completed']);
    assert.deepEqual(rehearsal.events('caller_journal', PROBE_PK), []);
    assert.equal(rehearsal.treatment()?.['state'], 'ARMED', 'the warm-up consumes no treatment');

    const report = await rehearsal.invokeProbe();
    assert.equal(report.attempt.outcome, 'TIMED_OUT');
    assert.deepEqual(rehearsal.logs.handledOutcomes(), ['canary_acknowledged', 'signal']);
  });

  it('ac002-rehearsal-nominal: BR-RUA-010..015 hold and cardinality is 1/1/1', async () => {
    const rehearsal = new TransportRehearsal();
    const report = await rehearsal.runProbeSequence();
    const caller = rehearsal.events('caller_journal', PROBE_PK);
    const experiment = rehearsal.events('experiment_journal', PROBE_PK);
    const timeout = only(caller, 'caller_timeout_recorded');
    const committed = only(experiment, 'provider_transaction_committed');
    const confirmed = only(experiment, 'provider_commit_confirmed');
    const signal = only(experiment, 'timeout_signal_recorded');
    const observed = only(experiment, 'treatment_timeout_observed');
    const released = only(experiment, 'treatment_response_released');

    // Cardinality: one caller invocation, one attempt, one provider call.
    assert.equal(caller.filter((event) => event.record_type === 'caller_invocation_started').length, 1);
    assert.equal(caller.filter((event) => event.record_type === 'attempt_registered').length, 1);
    assert.equal(experiment.filter((event) => event.record_type === 'provider_call_received').length, 1);
    assert.equal(rehearsal.store.itemsIn('ledger').length, 1);

    // BR-RUA-010: committed_at (from provider_commit_confirmed, D-24) precedes timer_fired_at.
    assert.ok(String(value(confirmed, 'committed_at')) < String(value(timeout, 'timer_fired_at')));

    // BR-RUA-011: the timer won after >= 3 s monotonic, aborted the transport, and caused the
    // durable timeout record; the transport was unsettled at the claim.
    assert.ok(BigInt(String(value(timeout, 'elapsed_ns'))) >= 3_000_000_000n);
    assert.equal(value(timeout, 'arbiter_winner'), 'TIMER');
    assert.equal(value(timeout, 'transport_settled_at_claim'), false);
    assert.deepEqual(timeout.causation_event_ids, [only(caller, 'dispatch_started').event_id]);
    assert.equal(value(only(caller, 'transport_settled_after_timeout'), 'settlement_kind'), 'aborted');

    // BR-RUA-012: the provider kept executing after the abort and finished normally.
    const [execution] = rehearsal.invoker.finished();
    assert.equal(rehearsal.invoker.finished().length, 1);
    assert.equal(execution?.aborted_by_client, true);
    assert.equal(execution.execution.kind, 'returned');
    assert.ok(String(value(released, 'occurred_at')) >= String(value(timeout, 'abort_requested_at')));

    // BR-RUA-013: the signal is caused by exactly the commit and the caller timeout, and the
    // provider then observed it.
    assert.deepEqual(signal.causation_event_ids, [committed.event_id, timeout.event_id].sort());
    assert.deepEqual(observed.causation_event_ids, [signal.event_id]);

    // BR-RUA-014: release only after observation, and no safety release.
    assert.deepEqual(released.causation_event_ids, [observed.event_id]);
    assert.equal(experiment.filter((event) => event.record_type === 'treatment_safety_released').length, 0);
    assert.equal(rehearsal.treatment()?.['state'], 'RESPONSE_RELEASED');

    // BR-RUA-015: the caller never observed the successful targeted response.
    assert.equal(report.attempt.outcome, 'TIMED_OUT');
    assert.equal(report.attempt.dispatch_state, 'DISPATCHED');
    assert.equal(value(only(caller, 'attempt_outcome_recorded'), 'outcome'), 'TIMED_OUT');
  });

  it('ac002-rehearsal-timer-early-fire: an early timer firing re-arms until 3 s have elapsed', async () => {
    const rehearsal = new TransportRehearsal();
    rehearsal.seedProbePartition();
    await rehearsal.acknowledgeCanary();
    await rehearsal.warmUpProvider();
    rehearsal.time.fireEarlyBy(1_000_000_000n);
    const report = await rehearsal.invokeProbe();
    const timeout = only(rehearsal.events('caller_journal', PROBE_PK), 'caller_timeout_recorded');
    assert.equal(value(timeout, 'elapsed_ns'), '3000000000');
    assert.equal(value(timeout, 'timer_fired_at'), '2026-10-05T12:00:03.000Z');
    assert.equal(report.attempt.outcome, 'TIMED_OUT');
    assert.deepEqual(rehearsal.logs.handledOutcomes(), ['canary_acknowledged', 'signal']);
  });

  it('ac002-rehearsal-stream-delay: a signal later than 15 s meets a safety release and is rejected as late', async () => {
    const rehearsal = new TransportRehearsal();
    rehearsal.seedProbePartition();
    await rehearsal.acknowledgeCanary();
    await rehearsal.warmUpProvider();
    rehearsal.feed.delay(16_000);
    const report = await rehearsal.invokeProbe();
    const experiment = rehearsal.events('experiment_journal', PROBE_PK);
    const safety = only(experiment, 'treatment_safety_released');
    const late = only(experiment, 'late_timeout_signal_rejected');
    assert.equal(value(safety, 'cause'), 'SAFETY_DEADLINE');
    assert.equal(value(safety, 'from_state'), 'COMMITTED_WAITING');
    assert.equal(experiment.filter((event) => event.record_type === 'timeout_signal_recorded').length, 0);
    assert.equal(value(late, 'treatment_state'), 'SAFETY_RELEASED');
    assert.ok(String(value(late, 'occurred_at')) > String(value(safety, 'occurred_at')));
    assert.equal(rehearsal.treatment()?.['state'], 'SAFETY_RELEASED');
    assert.equal(report.attempt.outcome, 'TIMED_OUT');
    assert.deepEqual(rehearsal.logs.handledOutcomes(), ['canary_acknowledged', 'late_rejected']);
  });

  it('ac002-rehearsal-duplicate-delivery: a re-delivered caller timeout is a duplicate, never a conflict', async () => {
    const rehearsal = new TransportRehearsal();
    rehearsal.seedProbePartition();
    await rehearsal.acknowledgeCanary();
    await rehearsal.warmUpProvider();
    rehearsal.feed.duplicateNext();
    await rehearsal.invokeProbe();
    const experiment = rehearsal.events('experiment_journal', PROBE_PK);
    assert.deepEqual(rehearsal.logs.handledOutcomes(), ['canary_acknowledged', 'signal', 'duplicate_ignored']);
    assert.equal(
      only(experiment, 'timeout_signal_duplicate_observed').record_type,
      'timeout_signal_duplicate_observed',
    );
    assert.equal(experiment.filter((event) => event.record_type === 'timeout_signal_conflict_recorded').length, 0);
    assert.equal(rehearsal.treatment()?.['state'], 'RESPONSE_RELEASED');
  });

  it('ac002-rehearsal-evidence-export: exports a schema-valid probe evidence directory', async () => {
    const rehearsal = new TransportRehearsal();
    await rehearsal.runProbeSequence();
    const evidence = collectProbeEvidence(rehearsal);
    assert.deepEqual(evidenceViolations(evidence, validator), []);
    const root = mkdtempSync(join(tmpdir(), 'rua-probe-rehearsal-'));
    try {
      const written = writeProbeEvidence(root, evidence);
      assert.deepEqual([...written].sort(), [
        'probe/inputs/payment.json',
        'probe/journals/caller-journal.jsonl',
        'probe/journals/controller-journal.jsonl',
        'probe/journals/provider-journal.jsonl',
        'probe/ledger/ledger-snapshot.json',
        'probe/state/provider-trial-configuration.json',
        'probe/state/treatment-state-snapshot.json',
        'readiness/canary-caller-journal.jsonl',
        'readiness/canary-controller-journal.jsonl',
        'readiness/warmup-provider-journal.jsonl',
      ]);
      const controller = parseJsonl(readFileSync(join(root, 'probe/journals/controller-journal.jsonl')));
      assert.deepEqual(
        controller.lines.map((line) =>
          line.parsed.ok ? (line.parsed.value as Readonly<Record<string, unknown>>)['record_type'] : 'invalid',
        ),
        ['timeout_signal_recorded'],
      );
      const ledger = evidence.get('probe/ledger/ledger-snapshot.json');
      assert.equal(ledger === undefined ? 0 : (recordsOf(ledger)[0]?.['transactions'] as readonly unknown[]).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
