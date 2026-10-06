// What the collectors feed downstream (design §8.2, §8.12; AC-RUA-007, AC-RUA-020). WP-25 closes
// no criterion; these tests prove the inputs it produces are the ones the consumers judge:
// - the collected ledger snapshot is what ingestion's pagination check reads, so an interrupted
//   read is reported as such (AC-RUA-007);
// - a sample built from one round of real collector reads (journals and treatment from the store,
//   ledger pages, queue counters, DLQ capture) restarts and establishes settlement exactly as the
//   §8.12 evaluator rules (AC-RUA-020), including activity at the pre-freeze recheck.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { capturePartitionKey } from '../../../src/evidence-collection/capture-scope.ts';
import { captureDlq } from '../../../src/evidence-collection/dlq-capture.ts';
import { exportJournals, unitJournalPlans } from '../../../src/evidence-collection/journal-export.ts';
import { captureLedgerSnapshot } from '../../../src/evidence-collection/ledger-capture.ts';
import { buildSettlementSample, settlementSampleRecord } from '../../../src/evidence-collection/settlement-sample.ts';
import type { SampleJournals } from '../../../src/evidence-collection/settlement-sample.ts';
import { CONTROL_ITEM_KEYS } from '../../../src/evidence-collection/state-capture.ts';
import { paginationProblems } from '../../../src/evidence-ingestion/ledger-view.ts';
import type { JsonObject, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { LedgerSnapshot } from '../../../src/record-contract/records/group-b/ledger_snapshot.ts';
import type { SettlementSamplePhase } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { evaluateSettlement } from '../../../src/settlement/evaluate-settlement.ts';
import { TRIAL_SETTLEMENT_POLICY } from '../../../src/settlement/settlement-policy.ts';
import type { SettlementSample } from '../../../src/settlement/settlement-policy.ts';
import type { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { storeHarness } from '../../support/durable-store/item-store-fixtures.ts';
import {
  assertValidRecord,
  collectionClock,
  journalItem,
  ledgerItem,
  sqsMessage,
  TRIAL_ID,
  TRIAL_PK,
  TRIAL_SCOPE,
} from '../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedDlqReceiver } from '../../support/evidence-collection/scripted-dlq-receiver.ts';
import { ScriptedPageReader } from '../../support/evidence-collection/scripted-page-reader.ts';
import { ScriptedQueueCounterReader } from '../../support/evidence-collection/scripted-queue-counter-reader.ts';

const PUBLISHED_AT = '2026-10-05T12:05:00.000Z' as UtcMillis;
const SOURCE = { queue_url: 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-source.fifo', queue_name: 'src' };
const DLQ = { queue_url: 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-dlq.fifo', queue_name: 'dlq' };
const CALL_ID = '00000000-0000-4000-8000-00000000c001';
const QUIET = { visible: 0, in_flight: 0, delayed: 0 };

/** The trial's live surfaces: store, queues and DLQ, read by the real collectors each round. */
interface TrialSurfaces {
  readonly store: InMemoryItemStore;
  readonly queues: ScriptedQueueCounterReader;
  readonly dlq: ScriptedDlqReceiver;
  callerSequence: number;
  providerSequence: number;
}

function trialSurfaces(): TrialSurfaces {
  const { store } = storeHarness(2);
  const queues = new ScriptedQueueCounterReader();
  queues.setCounters(SOURCE.queue_url, QUIET);
  queues.setCounters(DLQ.queue_url, QUIET);
  store.seed('ledger', ledgerItem(TRIAL_PK, 1));
  return { store, queues, dlq: new ScriptedDlqReceiver(), callerSequence: 0, providerSequence: 0 };
}

function callerEvent(surfaces: TrialSurfaces, processingState: string): void {
  surfaces.callerSequence += 1;
  surfaces.store.seed(
    'caller_journal',
    journalItem(TRIAL_PK, 'conventional_caller', surfaces.callerSequence, {
      record_type: 'request_state_recorded',
      processing_state: processingState,
    }),
  );
}

function providerEvent(surfaces: TrialSurfaces, recordType: string): void {
  surfaces.providerSequence += 1;
  surfaces.store.seed(
    'experiment_journal',
    journalItem(TRIAL_PK, 'refund_provider', surfaces.providerSequence, {
      record_type: recordType,
      provider_call_id: CALL_ID,
    }),
  );
}

async function journalsOf(surfaces: TrialSurfaces): Promise<SampleJournals> {
  const events = new Map<string, readonly JsonObject[]>();
  for (const plan of unitJournalPlans(capturePartitionKey(TRIAL_SCOPE))) {
    const exported = await exportJournals(surfaces.store, plan);
    assert.ok(exported.ok);
    for (const file of exported.value) {
      events.set(file.file, file.events);
    }
  }
  return {
    caller: events.get('callerJournal') ?? [],
    provider: events.get('providerJournal') ?? [],
    controller: events.get('controllerJournal') ?? [],
  };
}

// One round of independent reads, composed the way the live observer composes them (§10.2 T7).
async function sampleRound(
  surfaces: TrialSurfaces,
  observedAt: string,
  phase: SettlementSamplePhase = 'observation',
): Promise<SettlementSample> {
  const clock = collectionClock();
  const ledger = await captureLedgerSnapshot(surfaces.store, TRIAL_SCOPE, clock);
  const dlq = await captureDlq(surfaces.dlq, DLQ, TRIAL_SCOPE, clock);
  const source = await surfaces.queues.read(SOURCE.queue_url);
  const dlqCounters = await surfaces.queues.read(DLQ.queue_url);
  const treatment = await surfaces.store.getConsistent('control', { pk: TRIAL_PK, sk: CONTROL_ITEM_KEYS.treatment });
  assert.ok(treatment.ok);
  const sample = buildSettlementSample({
    observed_at: observedAt as UtcMillis,
    phase,
    publication_stopped: true,
    unit: {
      kind: 'conventional',
      scenario: 'CONTROL',
      queues: {
        source_queue: source.ok ? source.value : 'unavailable',
        dlq: dlqCounters.ok ? dlqCounters.value : 'unavailable',
        correlated_dlq_message_ids: dlq.correlated_message_ids,
        dlq_captured_message_ids: dlq.captured_message_ids,
      },
    },
    journals: await journalsOf(surfaces),
    treatment: treatment.value,
    ledger: { complete: ledger.complete, item_count: ledger.transaction_count },
  });
  assertValidRecord(settlementSampleRecord(sample, TRIAL_SCOPE), `sample at ${observedAt}`);
  return sample;
}

function at(minute: number, second: number): string {
  return new Date(Date.UTC(2026, 9, 5, 12, minute, second)).toISOString();
}

describe('AC-RUA-007 feed: the collected ledger snapshot', () => {
  it('passes ingestion pagination checks when every page was read', async () => {
    const { store } = storeHarness(2);
    for (const serial of [1, 2, 3, 4, 5]) {
      store.seed('ledger', ledgerItem(TRIAL_PK, serial));
    }
    const ledger = await captureLedgerSnapshot(store, TRIAL_SCOPE, collectionClock());
    assertValidRecord(ledger.record);
    assert.deepEqual(paginationProblems(ledger.record as unknown as LedgerSnapshot), []);
  });

  it('is reported incomplete by ingestion when a page read failed', async () => {
    const reader = new ScriptedPageReader();
    reader.scriptPage('ledger', TRIAL_PK, {
      items: [ledgerItem(TRIAL_PK, 1)],
      next_cursor: 'p2',
      consistent_read: true,
    });
    reader.scriptPageFailure('ledger', TRIAL_PK, 'ProvisionedThroughputExceededException');
    const ledger = await captureLedgerSnapshot(reader, TRIAL_SCOPE, collectionClock());
    assertValidRecord(ledger.record);
    assert.equal(ledger.complete, false);
    assert.deepEqual(paginationProblems(ledger.record as unknown as LedgerSnapshot), [
      'complete is false',
      'the last page has next_cursor p2',
    ]);
  });

  it('is reported incomplete by ingestion when the store repeated a cursor', async () => {
    const reader = new ScriptedPageReader();
    reader.scriptPage('ledger', TRIAL_PK, {
      items: [ledgerItem(TRIAL_PK, 1)],
      next_cursor: 'p2',
      consistent_read: true,
    });
    reader.scriptPage('ledger', TRIAL_PK, {
      items: [ledgerItem(TRIAL_PK, 2)],
      next_cursor: 'p2',
      consistent_read: true,
    });
    const ledger = await captureLedgerSnapshot(reader, TRIAL_SCOPE, collectionClock());
    assertValidRecord(ledger.record);
    assert.deepEqual(paginationProblems(ledger.record as unknown as LedgerSnapshot), [
      'complete is false',
      'the last page has next_cursor p2',
    ]);
  });
});

describe('AC-RUA-020 feed: samples from real collector reads', () => {
  it('restarts on provider and journal activity, then establishes after 120 s quiet and a quiet recheck', async () => {
    const surfaces = trialSurfaces();
    callerEvent(surfaces, 'RUNNING');
    providerEvent(surfaces, 'provider_call_received');
    const samples = [await sampleRound(surfaces, at(5, 30))];
    providerEvent(surfaces, 'provider_response_returned');
    callerEvent(surfaces, 'FINISHED');
    for (const second of [0, 30, 60, 90, 120, 150]) {
      samples.push(await sampleRound(surfaces, at(6, second)));
    }
    samples.push(await sampleRound(surfaces, at(8, 35), 'pre_freeze_recheck'));

    const assessment = evaluateSettlement(samples, TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT);
    assert.deepEqual(assessment, {
      status: 'established',
      window_start: at(6, 30),
      established_at: at(8, 30),
      rechecked_at: at(8, 35),
      restarts: [
        { at: at(5, 30), cause: 'PROVIDER_ACTIVE' },
        { at: at(6, 0), cause: 'CORRELATED_JOURNAL_ACTIVITY' },
      ],
    });
  });

  it('records PRE_FREEZE_ACTIVITY when the recheck sees a new journal event, and does not establish', async () => {
    const surfaces = trialSurfaces();
    callerEvent(surfaces, 'FINISHED');
    const samples: SettlementSample[] = [];
    for (const second of [0, 30, 60, 90, 120]) {
      samples.push(await sampleRound(surfaces, at(6, second)));
    }
    providerEvent(surfaces, 'provider_call_received');
    providerEvent(surfaces, 'provider_call_rejected');
    samples.push(await sampleRound(surfaces, at(8, 5), 'pre_freeze_recheck'));

    const assessment = evaluateSettlement(samples, TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT);
    assert.equal(assessment.status, 'not_established');
    assert.deepEqual(assessment.restarts, [{ at: at(8, 5), cause: 'PRE_FREEZE_ACTIVITY' }]);
  });

  it('treats a captured dead-lettered trial message as terminal processing, after one restart', async () => {
    const surfaces = trialSurfaces();
    callerEvent(surfaces, 'RUNNING');
    const samples = [await sampleRound(surfaces, at(5, 30))];
    surfaces.dlq.enqueue(sqsMessage({ id: 'm1', group: TRIAL_ID }));
    surfaces.queues.setCounters(DLQ.queue_url, { visible: 1, in_flight: 0, delayed: 0 });
    for (const second of [0, 30, 60, 90, 120, 150]) {
      samples.push(await sampleRound(surfaces, at(6, second)));
    }
    samples.push(await sampleRound(surfaces, at(8, 35), 'pre_freeze_recheck'));

    const [, dead] = samples;
    assert.equal(dead?.processing_terminal, true);
    assert.deepEqual(dead.correlated_dlq_message_ids, ['m1']);
    const assessment = evaluateSettlement(samples, TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT);
    assert.equal(assessment.status, 'established');
    assert.deepEqual(assessment.restarts, [
      { at: at(5, 30), cause: 'PROCESSING_NOT_TERMINAL' },
      { at: at(6, 0), cause: 'NEW_CORRELATED_DLQ_MESSAGE' },
    ]);
  });

  it('restarts on a visible, then an in-flight source message during stabilization (AC-RUA-020 cases)', async () => {
    const surfaces = trialSurfaces();
    callerEvent(surfaces, 'FINISHED');
    const samples = [await sampleRound(surfaces, at(6, 0)), await sampleRound(surfaces, at(6, 30))];
    surfaces.queues.setCounters(SOURCE.queue_url, { visible: 1, in_flight: 0, delayed: 0 });
    samples.push(await sampleRound(surfaces, at(7, 0)));
    surfaces.queues.setCounters(SOURCE.queue_url, { visible: 0, in_flight: 1, delayed: 0 });
    samples.push(await sampleRound(surfaces, at(7, 30)));
    surfaces.queues.setCounters(SOURCE.queue_url, QUIET);
    for (const second of [0, 30, 60, 90, 120]) {
      samples.push(await sampleRound(surfaces, at(8, second)));
    }
    samples.push(await sampleRound(surfaces, at(10, 5), 'pre_freeze_recheck'));

    const assessment = evaluateSettlement(samples, TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT);
    assert.deepEqual(assessment, {
      status: 'established',
      window_start: at(8, 0),
      established_at: at(10, 0),
      rechecked_at: at(10, 5),
      restarts: [
        { at: at(7, 0), cause: 'SOURCE_VISIBLE' },
        { at: at(7, 30), cause: 'SOURCE_IN_FLIGHT' },
      ],
    });
  });

  it('never settles while the ledger read cannot finish or a queue cannot be read', async () => {
    const surfaces = trialSurfaces();
    callerEvent(surfaces, 'FINISHED');
    surfaces.queues.scriptFailure(SOURCE.queue_url, 'ThrottlingException');
    const unreadable = await sampleRound(surfaces, at(6, 0));
    assert.equal(unreadable.source_queue, 'unavailable');
    surfaces.store.scriptReadFault('ProvisionedThroughputExceededException', {
      operation: 'queryPartitionPage',
      table: 'ledger',
    });
    const unfinished = await sampleRound(surfaces, at(6, 30));
    assert.equal(unfinished.ledger_snapshot_possible, false);
    assert.deepEqual(unfinished.source_queue, QUIET, 'the queue read recovered; only the ledger is unfinished');
    const assessment = evaluateSettlement([unreadable, unfinished], TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT);
    assert.equal(assessment.status, 'not_established');
    assert.deepEqual(assessment.restarts, [
      { at: at(6, 0), cause: 'QUEUE_UNAVAILABLE' },
      { at: at(6, 30), cause: 'LEDGER_ACTIVITY' },
    ]);
  });
});
