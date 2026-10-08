// Catalogue group C row 72 (design §6.2, §6.3): the canonical run summary (CTR-RUA-002). It has
// exactly four trial results in declared order and no winner, aggregate, ranking or statistic.

import type { SafetyResult } from '../group-b/vocabulary.ts';
import type { Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../../primitives.ts';
import type { ArtifactRef, ExecutionScoped, SummaryTrialResult } from './shared-shapes.ts';
import type {
  ApplicableGateValue,
  CleanupStatus,
  ExecutionStatus,
  LeakAuditStatus,
  LeaseStatus,
  RunTerminalReason,
} from './vocabulary.ts';

/** BR-RUA-031: an eligible comparison has no reasons, an ineligible one at least one. */
export type ComparisonEligibilityOutcome =
  | { readonly comparison_eligibility: 'eligible'; readonly comparison_ineligibility_reasons: readonly [] }
  | {
      readonly comparison_eligibility: 'ineligible';
      readonly comparison_ineligibility_reasons: readonly [StructuredReason, ...StructuredReason[]];
    };

interface RunSummaryFields extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'run_summary';
  readonly run_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  /** BR-RUA-019 order: conventional CONTROL, durable CONTROL, conventional and durable treatment. */
  readonly trial_results: readonly [SummaryTrialResult, SummaryTrialResult, SummaryTrialResult, SummaryTrialResult];
  readonly execution_status: ExecutionStatus;
  readonly run_terminal_reason: RunTerminalReason;
  readonly cleanup_status: CleanupStatus;
  readonly leak_audit_status: LeakAuditStatus;
  readonly lease_status: LeaseStatus;
  readonly safety_status: SafetyResult;
  readonly evidence_integrity_status: ApplicableGateValue;
  readonly cleanup_result_ref: ArtifactRef;
  readonly late_evidence_assessment_ref: ArtifactRef;
  readonly comparison_assessment_ref: ArtifactRef;
  readonly created_at: UtcMillis;
}

/** Schema: `schemas/group-c/run_summary.schema.json`. */
export type RunSummary = RunSummaryFields & ComparisonEligibilityOutcome;
