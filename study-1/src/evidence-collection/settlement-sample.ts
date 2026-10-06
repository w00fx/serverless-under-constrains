// One settlement sample from one round of independent reads (design §5.3 `buildSettlementSample`,
// §8.12; BR-RUA-032, D-32). The live observer reads the journals, the treatment item, the ledger,
// the queues, the DLQ and (for Durable) the inner executions, and this pure function turns those
// readings into the `settlement_sample` fields the §8.12 evaluator judges, so the observer and the
// oracle's G6 read the same values:
// - processing is terminal when the caller journal holds a FINISHED `request_state_recorded`, or
//   when a correlated message was captured from the DLQ: DLQ evidence is authoritative terminal
//   evidence (§8.7 (b)), and a throttled delivery can reach the DLQ before any caller records
//   FINISHED (RK-08). For the probe it is the probe workload invocation having returned;
// - the treatment is terminal in RESPONSE_RELEASED or SAFETY_RELEASED, and not applicable to a
//   CONTROL trial, which has no treatment item;
// - the correlated-event watermark counts the events of the trial's caller, provider and
//   controller journals, so any new event is CORRELATED_JOURNAL_ACTIVITY;
// - a ledger read that did not finish makes the snapshot impossible (LEDGER_ACTIVITY);
// - queue counters that could not be read stay `unavailable`, never quiet.

import type { JsonObject, JsonValue, UtcMillis } from '../record-contract/primitives.ts';
import type { Scenario } from '../record-contract/primitives.ts';
import type { SettlementSamplePhase } from '../record-contract/records/group-b/vocabulary.ts';
import type { QueueCounters, SettlementSample } from '../settlement/settlement-policy.ts';
import { correlationFields } from './capture-scope.ts';
import type { CaptureScope } from './capture-scope.ts';
import { deriveProviderActivity } from './provider-activity.ts';
import { countersJson } from './queue-observation.ts';
import { ownValue } from './sdk-values.ts';

/** The queue and DLQ readings of a queued trial. */
export interface QueueSampleReadings {
  readonly source_queue: QueueCounters | 'unavailable';
  readonly dlq: QueueCounters | 'unavailable';
  /** Captured DLQ messages whose group id is the trial id. */
  readonly correlated_dlq_message_ids: readonly string[];
  /** Every DLQ message captured, correlated or not. */
  readonly dlq_captured_message_ids: readonly string[];
}

/** What kind of unit the sample is for, with the readings only that kind has. */
export type SampleUnitReadings =
  | { readonly kind: 'conventional'; readonly scenario: Scenario; readonly queues: QueueSampleReadings }
  | {
      readonly kind: 'durable';
      readonly scenario: Scenario;
      readonly queues: QueueSampleReadings;
      readonly inner_executions_terminal: boolean;
    }
  | { readonly kind: 'probe'; readonly invocation_returned: boolean };

/** The journal events of the unit's partitions, as exported. */
export interface SampleJournals {
  readonly caller: readonly JsonObject[];
  readonly provider: readonly JsonObject[];
  readonly controller: readonly JsonObject[];
}

/** One round of reads (design §5.3 `SettlementSampleInput`). */
export interface SettlementSampleInput {
  readonly observed_at: UtcMillis;
  readonly phase: SettlementSamplePhase;
  /** True once the runner's publication for the unit is done and no further publication can happen. */
  readonly publication_stopped: boolean;
  readonly unit: SampleUnitReadings;
  readonly journals: SampleJournals;
  /** The treatment item without its key, or undefined when the partition holds none. */
  readonly treatment: JsonObject | undefined;
  readonly ledger: { readonly complete: boolean; readonly item_count: number };
}

const TERMINAL_TREATMENT_STATES: readonly string[] = ['RESPONSE_RELEASED', 'SAFETY_RELEASED'];

/**
 * Builds the sample the §8.12 evaluator reads from one round of reads. Pure.
 *
 * @example
 * evaluateSettlement(rounds.map(buildSettlementSample), TRIAL_SETTLEMENT_POLICY, publishedAt);
 */
export function buildSettlementSample(input: SettlementSampleInput): SettlementSample {
  const { unit, journals } = input;
  const activity = deriveProviderActivity(journals.provider, input.treatment);
  const queues = unit.kind === 'probe' ? undefined : unit.queues;
  return {
    observed_at: input.observed_at,
    phase: input.phase,
    publication_stopped: input.publication_stopped,
    processing_terminal: processingTerminal(unit, journals.caller),
    inner_executions_terminal: unit.kind === 'durable' ? unit.inner_executions_terminal : 'not_applicable',
    provider_active_calls: activity.active_calls,
    provider_held_barriers: activity.held_barriers,
    provider_pending_releases: activity.pending_releases,
    treatment_terminal:
      unit.kind !== 'probe' && unit.scenario === 'CONTROL' ? 'not_applicable' : treatmentTerminal(input.treatment),
    ledger_snapshot_possible: input.ledger.complete,
    source_queue: queues?.source_queue ?? 'not_applicable',
    dlq: queues?.dlq ?? 'not_applicable',
    correlated_dlq_message_ids: [...(queues?.correlated_dlq_message_ids ?? [])],
    dlq_captured_message_ids: [...(queues?.dlq_captured_message_ids ?? [])],
    correlated_event_watermark: journals.caller.length + journals.provider.length + journals.controller.length,
    ledger_item_count: input.ledger.item_count,
  };
}

/**
 * The `settlement_sample` record (catalogue row 58) of a sample: its fields plus the correlation.
 *
 * @example
 * settlementSampleRecord(sample, scope)['record_type']; // 'settlement_sample'
 */
export function settlementSampleRecord(sample: SettlementSample, scope: CaptureScope): JsonObject {
  return {
    schema_version: 1,
    record_type: 'settlement_sample',
    ...correlationFields(scope),
    ...sample,
    source_queue: queueJson(sample.source_queue),
    dlq: queueJson(sample.dlq),
    correlated_dlq_message_ids: [...sample.correlated_dlq_message_ids],
    dlq_captured_message_ids: [...sample.dlq_captured_message_ids],
  };
}

function processingTerminal(unit: SampleUnitReadings, callerEvents: readonly JsonObject[]): boolean {
  if (unit.kind === 'probe') {
    return unit.invocation_returned;
  }
  const finished = callerEvents.some(
    (event) =>
      ownValue(event, 'record_type') === 'request_state_recorded' && ownValue(event, 'processing_state') === 'FINISHED',
  );
  return finished || unit.queues.correlated_dlq_message_ids.length > 0;
}

function treatmentTerminal(treatment: JsonObject | undefined): boolean {
  const state = ownValue(treatment, 'state');
  return typeof state === 'string' && TERMINAL_TREATMENT_STATES.includes(state);
}

function queueJson(counters: SettlementSample['source_queue']): JsonValue {
  return typeof counters === 'string' ? counters : countersJson(counters);
}
