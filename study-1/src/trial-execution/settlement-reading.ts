// One round of independent settlement reads of a trial or of the transport probe (design §8.12,
// §10.2 T7; BR-RUA-032): the unit's journals, its treatment item, its ledger and, for a trial, the
// source queue and DLQ counters, the correlated DLQ messages (received without deletion, only when
// the DLQ holds any) and, for a Durable trial, its inner executions. `buildSettlementSample` turns
// the readings into the sample the §8.12 evaluator judges; a trial's two queue observations are
// kept for `queues/source-observations.jsonl` and `queues/dlq-observations.jsonl`. The probe has
// no queue (design §7: its directory has no `queues/`); its processing is terminal once the
// runner's synchronous Invoke of the probe caller returned.
//
// Reads fail closed. Queue counters that cannot be read are `unavailable` (never quiet). A
// journal or treatment read that fails raises the correlated-event watermark above the previous
// sample's, so the round counts as CORRELATED_JOURNAL_ACTIVITY: the observer cannot tell that
// nothing happened, so it must not let the window run on (evidence/WP-26/decisions.md).

import type { DlqReceiver } from '../evidence-collection/dlq-capture.ts';
import { captureDlq } from '../evidence-collection/dlq-capture.ts';
import type { CollectorStoreReader } from '../evidence-collection/collected-records.ts';
import { capturePartitionKey } from '../evidence-collection/capture-scope.ts';
import type { CaptureScope, TrialCaptureScope } from '../evidence-collection/capture-scope.ts';
import { innerExecutionsTerminal, listDurableExecutions } from '../evidence-collection/durable-metadata.ts';
import type { DurableExecutionReader, DurableListingRequest } from '../evidence-collection/durable-metadata.ts';
import { exportJournals, unitJournalPlans } from '../evidence-collection/journal-export.ts';
import { captureLedgerSnapshot } from '../evidence-collection/ledger-capture.ts';
import { observeQueue } from '../evidence-collection/queue-observation.ts';
import type { QueueCounterReader, QueueTarget } from '../evidence-collection/queue-observation.ts';
import { buildSettlementSample } from '../evidence-collection/settlement-sample.ts';
import type {
  QueueSampleReadings,
  SampleJournals,
  SampleUnitReadings,
} from '../evidence-collection/settlement-sample.ts';
import type { JsonObject, Scenario, StructuredReason, WallClock } from '../record-contract/primitives.ts';
import type { SettlementSamplePhase } from '../record-contract/records/group-b/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { TREATMENT_SORT_KEY } from '../refund-provider/control-items.ts';
import type { QueueCounters, SettlementSample } from '../settlement/settlement-policy.ts';

/** The ports a probe round reads through: the tables and the clock. */
export interface UnitReadingPorts {
  readonly store: CollectorStoreReader;
  readonly clock: WallClock;
}

/** The ports a trial round reads through: the tables, the queues, the DLQ and Durable. */
export interface SettlementReadingPorts extends UnitReadingPorts {
  readonly queues: QueueCounterReader;
  readonly dlq: DlqReceiver;
  readonly durable: DurableExecutionReader;
}

/** What a trial round reads: the trial, its scenario, its queues and, for Durable, its executions. */
export interface SettlementReadingTarget {
  readonly scope: TrialCaptureScope;
  readonly scenario: Scenario;
  readonly source: QueueTarget;
  readonly dlq: QueueTarget;
  readonly durable?: DurableListingRequest;
}

/** One round: the sample, a trial's two queue observations and every read that failed. */
export interface SettlementReading {
  readonly sample: SettlementSample;
  /** Absent for the probe, which has no queue. */
  readonly source_observation?: JsonObject;
  /** Absent for the probe, which has no queue. */
  readonly dlq_observation?: JsonObject;
  readonly failures: readonly StructuredReason[];
}

/** One round of settlement reads of a unit, as the observer takes them. */
export type SettlementRoundReader = (
  phase: SettlementSamplePhase,
  previous: SettlementSample | undefined,
) => Promise<SettlementReading>;

/** The unit-specific part of a round: its readings and, for a trial, its queue observations. */
interface UnitRound {
  readonly unit: SampleUnitReadings;
  readonly observations?: { readonly source: JsonObject; readonly dlq: JsonObject };
}

interface JournalReading {
  readonly journals: SampleJournals;
  readonly complete: boolean;
}

/**
 * Reads one settlement round of a published trial.
 *
 * @example
 * const round = await readSettlementRound(ports, target, 'observation', previous);
 * round.sample.source_queue; // { visible: 0, in_flight: 0, delayed: 0 }
 */
export function readSettlementRound(
  ports: SettlementReadingPorts,
  target: SettlementReadingTarget,
  phase: SettlementSamplePhase,
  previous: SettlementSample | undefined,
): Promise<SettlementReading> {
  return readUnitRound(ports, target.scope, phase, previous, async (failures) => {
    const source = await observeQueue(ports.queues, target.source, 'source', target.scope, ports.clock);
    const dlq = await observeQueue(ports.queues, target.dlq, 'dlq', target.scope, ports.clock);
    const queues = await readDlqMessages(ports, target, source.counters, dlq.counters, failures);
    const unit = await unitReadings(ports, target, queues, failures);
    return { unit, observations: { source: source.record, dlq: dlq.record } };
  });
}

/**
 * Reads one settlement round of the transport probe: its partition's journals, treatment and
 * ledger, with processing terminal once the probe caller's Invoke returned.
 *
 * @example
 * const round = await readProbeSettlementRound(ports, scope, true, 'observation', previous);
 * round.sample.source_queue; // 'not_applicable'
 */
export function readProbeSettlementRound(
  ports: UnitReadingPorts,
  scope: CaptureScope,
  invocationReturned: boolean,
  phase: SettlementSamplePhase,
  previous: SettlementSample | undefined,
): Promise<SettlementReading> {
  return readUnitRound(ports, scope, phase, previous, () =>
    Promise.resolve({ unit: { kind: 'probe', invocation_returned: invocationReturned } }),
  );
}

// The reads every unit shares, in order: journals, treatment, ledger, then the unit's own reads.
async function readUnitRound(
  ports: UnitReadingPorts,
  scope: CaptureScope,
  phase: SettlementSamplePhase,
  previous: SettlementSample | undefined,
  readUnit: (failures: StructuredReason[]) => Promise<UnitRound>,
): Promise<SettlementReading> {
  const observedAt = formatUtcMillis(ports.clock.now());
  const failures: StructuredReason[] = [];
  const journals = await readJournals(ports.store, scope, failures);
  const treatment = await readTreatment(ports.store, scope, failures);
  const ledger = await captureLedgerSnapshot(ports.store, scope, ports.clock);
  failures.push(...ledger.failures);
  const round = await readUnit(failures);
  const built = buildSettlementSample({
    observed_at: observedAt,
    phase,
    publication_stopped: true,
    unit: round.unit,
    journals: journals.journals,
    treatment: treatment.item,
    ledger: { complete: ledger.complete, item_count: ledger.transaction_count },
  });
  const unread = !journals.complete || !treatment.complete;
  const floor = (previous?.correlated_event_watermark ?? 0) + 1;
  const sample = unread
    ? { ...built, correlated_event_watermark: Math.max(built.correlated_event_watermark, floor) }
    : built;
  const observations =
    round.observations === undefined
      ? {}
      : { source_observation: round.observations.source, dlq_observation: round.observations.dlq };
  return { sample, ...observations, failures };
}

async function readJournals(
  store: CollectorStoreReader,
  scope: CaptureScope,
  failures: StructuredReason[],
): Promise<JournalReading> {
  const files = new Map<string, readonly JsonObject[]>();
  let complete = true;
  for (const plan of unitJournalPlans(capturePartitionKey(scope))) {
    const exported = await exportJournals(store, plan);
    if (!exported.ok) {
      failures.push(exported.error);
      complete = false;
      continue;
    }
    for (const file of exported.value) {
      files.set(file.file, file.events);
    }
  }
  const events = (file: string): readonly JsonObject[] => files.get(file) ?? [];
  return {
    journals: {
      caller: events('callerJournal'),
      provider: events('providerJournal'),
      controller: events('controllerJournal'),
    },
    complete,
  };
}

async function readTreatment(
  store: CollectorStoreReader,
  scope: CaptureScope,
  failures: StructuredReason[],
): Promise<{ readonly item: JsonObject | undefined; readonly complete: boolean }> {
  const pk = capturePartitionKey(scope);
  const read = await store.getConsistent('control', { pk, sk: TREATMENT_SORT_KEY });
  if (!read.ok) {
    failures.push({
      code: 'TREATMENT_READ_FAILED',
      subject: 'BR-RUA-032',
      detail: `control item ${pk}/${TREATMENT_SORT_KEY} read failed with ${read.error.code}; expected a consistent read each settlement round`,
    });
    return { item: undefined, complete: false };
  }
  if (read.value === undefined) {
    return { item: undefined, complete: true };
  }
  const { pk: _pk, sk: _sk, ...item } = read.value;
  return { item, complete: true };
}

// The DLQ is received only when its counters show a message: a receive is a read the collector
// must account for, and an empty DLQ has nothing to capture.
async function readDlqMessages(
  ports: SettlementReadingPorts,
  target: SettlementReadingTarget,
  source: QueueCounters | 'unavailable',
  dlq: QueueCounters | 'unavailable',
  failures: StructuredReason[],
): Promise<QueueSampleReadings> {
  const empty = { source_queue: source, dlq, correlated_dlq_message_ids: [], dlq_captured_message_ids: [] };
  if (dlq === 'unavailable' || dlq.visible + dlq.in_flight + dlq.delayed === 0) {
    return empty;
  }
  const capture = await captureDlq(ports.dlq, target.dlq, target.scope, ports.clock);
  failures.push(...capture.failures);
  return {
    ...empty,
    correlated_dlq_message_ids: capture.correlated_message_ids,
    dlq_captured_message_ids: capture.captured_message_ids,
  };
}

async function unitReadings(
  ports: SettlementReadingPorts,
  target: SettlementReadingTarget,
  queues: QueueSampleReadings,
  failures: StructuredReason[],
): Promise<SampleUnitReadings> {
  if (target.durable === undefined) {
    return { kind: 'conventional', scenario: target.scenario, queues };
  }
  const listing = await listDurableExecutions(ports.durable, target.durable);
  failures.push(...listing.failures);
  return {
    kind: 'durable',
    scenario: target.scenario,
    queues,
    inner_executions_terminal: innerExecutionsTerminal(listing),
  };
}
