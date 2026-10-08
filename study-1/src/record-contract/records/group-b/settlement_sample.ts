// Catalogue group B row 58 (design §6.2, §5.3 `SettlementSample`): one settlement observation,
// a line of `settlement/settlement-samples.jsonl` (BR-RUA-032, D-32).

import type { UtcMillis } from '../../primitives.ts';
import type { ExecutionCorrelation, ExecutionScoped, QueueCounters, TrialScoped } from './shared-shapes.ts';
import type { QueueCounterMarker, SettlementSamplePhase } from './vocabulary.ts';

/** The fields the BR-RUA-032 evaluator reads, in the shape it reads them. */
export interface SettlementSampleFields {
  readonly schema_version: 1;
  readonly record_type: 'settlement_sample';
  readonly observed_at: UtcMillis;
  readonly phase: SettlementSamplePhase;
  readonly publication_stopped: boolean;
  readonly processing_terminal: boolean;
  readonly inner_executions_terminal: boolean | 'not_applicable';
  readonly provider_active_calls: number;
  readonly provider_held_barriers: number;
  readonly provider_pending_releases: number;
  readonly treatment_terminal: boolean | 'not_applicable';
  readonly ledger_snapshot_possible: boolean;
  readonly source_queue: QueueCounters | QueueCounterMarker;
  readonly dlq: QueueCounters | QueueCounterMarker;
  readonly correlated_dlq_message_ids: readonly string[];
  readonly dlq_captured_message_ids: readonly string[];
  readonly correlated_event_watermark: number;
  readonly ledger_item_count: number;
}

/** Schema: `schemas/group-b/settlement_sample.schema.json`. Probe samples carry no trial identity. */
export type SettlementSample = ExecutionCorrelation & SettlementSampleFields & (TrialScoped | ExecutionScoped);
