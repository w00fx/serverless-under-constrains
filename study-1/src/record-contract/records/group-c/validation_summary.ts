// Catalogue group C row 71 (design §6.2, §6.3, §8.15): the variant-validation summary
// (BR-RUA-038). It has one variant, two trials (CONTROL then COMMIT_THEN_TIMEOUT), no `run_id`
// and no cross-variant field.

import type { SafetyResult } from '../group-b/vocabulary.ts';
import type { Sha256Hex, StructuredReason, Uuid4, UtcMillis, VariantId } from '../../primitives.ts';
import type { ArtifactRef, ExecutionScoped, SummaryTrialResult } from './shared-shapes.ts';
import type {
  ApplicableGateValue,
  CleanupStatus,
  ImplementationValidationStatus,
  LateEvidenceStatus,
  LeakAuditStatus,
  LeaseStatus,
  TrialValidity,
  ValidationTerminalReason,
} from './vocabulary.ts';

/** Schema: `schemas/group-c/validation_summary.schema.json`. */
export interface ValidationSummary extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'validation_summary';
  readonly variant_validation_id: Uuid4;
  readonly variant_id: VariantId;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly trial_results: readonly [SummaryTrialResult, SummaryTrialResult];
  readonly validation_terminal_reason: ValidationTerminalReason;
  readonly validation_validity: TrialValidity;
  readonly implementation_validation_status: ImplementationValidationStatus;
  /** Why the status is not `verified`; empty when it is. */
  readonly status_reasons: readonly StructuredReason[];
  readonly cleanup_status: CleanupStatus;
  readonly leak_audit_status: LeakAuditStatus;
  readonly lease_status: LeaseStatus;
  readonly safety_status: SafetyResult;
  readonly evidence_integrity_status: ApplicableGateValue;
  readonly late_evidence_status: LateEvidenceStatus;
  readonly cleanup_result_ref: ArtifactRef;
  readonly late_evidence_assessment_ref: ArtifactRef;
  readonly created_at: UtcMillis;
}
