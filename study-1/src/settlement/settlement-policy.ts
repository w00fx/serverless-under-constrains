// The BR-RUA-032 settlement policies and the shapes the evaluator reads (design §5.3 `settlement/`,
// §8.12). A sample is the `settlement_sample` record without its envelope and correlation: the
// live observer builds one per poll and the oracle reads the frozen ones, so both judge the same
// fields. The timing values are the spec's reference tables, never environment input.

import type { StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { SettlementSampleFields } from '../record-contract/records/group-b/settlement_sample.ts';
import type { SettlementRestartCause } from '../record-contract/records/group-b/vocabulary.ts';

export type { QueueCounters } from '../record-contract/records/group-b/shared-shapes.ts';
export type { SettlementRestartCause } from '../record-contract/records/group-b/vocabulary.ts';

/** One settlement observation as the evaluator reads it (design §5.3 `SettlementSample`). */
export type SettlementSample = Omit<SettlementSampleFields, 'schema_version' | 'record_type'>;

/** How long quiet must last, when observation stops, and how often the observer polls. */
export interface SettlementPolicy {
  readonly stabilization_ms: number;
  readonly observation_deadline_ms: number;
  readonly poll_interval_ms: number;
}

/** OR-RUA-002: stabilization 120 s, observation deadline 600 s, queue poll every 30 s. */
export const TRIAL_SETTLEMENT_POLICY: SettlementPolicy = {
  stabilization_ms: 120_000,
  observation_deadline_ms: 600_000,
  poll_interval_ms: 30_000,
};

/**
 * OR-RUA-004: probe stabilization 120 s within its 600 s of active time; the probe polls at the
 * trial cadence (evidence/WP-14/decisions.md).
 */
export const PROBE_SETTLEMENT_POLICY: SettlementPolicy = {
  stabilization_ms: 120_000,
  observation_deadline_ms: 600_000,
  poll_interval_ms: 30_000,
};

/** One restart of the stabilization window. */
export interface SettlementRestart {
  readonly at: UtcMillis;
  readonly cause: SettlementRestartCause;
}

/** The evaluator's judgement (design §5.3 `SettlementAssessment`). */
export type SettlementAssessment =
  | {
      readonly status: 'established';
      readonly window_start: UtcMillis;
      readonly established_at: UtcMillis;
      readonly rechecked_at: UtcMillis;
      readonly restarts: readonly SettlementRestart[];
    }
  | {
      readonly status: 'not_established';
      readonly reasons: readonly StructuredReason[];
      readonly restarts: readonly SettlementRestart[];
    };
