// Catalogue group C row 78 (design §6.2, §8.13): the late-evidence assessment frozen at
// cleanup step 2 (BR-RUA-043, D-16). It never modifies a frozen result or digest.

import type { EvidenceRef } from '../../evidence-refs.ts';
import type { JsonValue, Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../../primitives.ts';
import type { ArtifactRef, ExecutionCorrelation, ExecutionScoped } from './shared-shapes.ts';
import type { LateEvidenceStatus, LateMonitoringOutcome } from './vocabulary.ts';

/** One verdict-projection field that differs between the frozen and the reassessed result. */
export interface ProjectionChange {
  /** JSON Pointer into the result, for example `/preservation_verdict`. */
  readonly field: string;
  readonly frozen: JsonValue;
  readonly reassessed: JsonValue;
}

/** The reassessment of one frozen oracle or probe result. */
export interface FrozenResultReassessment {
  readonly frozen_result_ref: ArtifactRef;
  readonly trial_id?: Uuid4;
  readonly status: LateEvidenceStatus;
  readonly changes: readonly ProjectionChange[];
}

interface LateEvidenceAssessmentHead extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'late_evidence_assessment';
  readonly execution_manifest_sha256: Sha256Hex;
  /** Both monitoring times are omitted when monitoring was skipped; the end needs the start. */
  readonly monitoring_started_at?: UtcMillis;
  readonly monitoring_ended_at?: UtcMillis;
  readonly correlated_record_count: number;
  readonly reassessments: readonly FrozenResultReassessment[];
  readonly reasons: readonly StructuredReason[];
  readonly evidence_refs: readonly EvidenceRef[];
  readonly assessed_at: UtcMillis;
}

/** D-16: `unverified` exactly when monitoring was shortened, skipped or failed. */
export type MonitoringOutcome =
  | { readonly monitoring: 'complete'; readonly late_evidence_status: Exclude<LateEvidenceStatus, 'unverified'> }
  | { readonly monitoring: Exclude<LateMonitoringOutcome, 'complete'>; readonly late_evidence_status: 'unverified' };

/** Schema: `schemas/group-c/late_evidence_assessment.schema.json`. */
export type LateEvidenceAssessment = ExecutionCorrelation & LateEvidenceAssessmentHead & MonitoringOutcome;
