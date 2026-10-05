// Catalogue group C row 73 (design §6.2, §8.14): BR-RUA-007 equality projections and the
// BR-RUA-031 / BR-RUA-052 eligibility conditions of one canonical run. A `pass` or `fail`
// verdict never affects eligibility.

import type { EvidenceRef } from '../../evidence-refs.ts';
import type { JsonValue, Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../../primitives.ts';
import type { ArtifactRef, ExecutionScoped } from './shared-shapes.ts';
import type { ComparisonEligibilityOutcome } from './run_summary.ts';
import type { ComparisonCheckId, EqualityProjectionId, PreservationVerdict } from './vocabulary.ts';

/** One field value per trial that compared it. */
export interface ProjectedFieldValue {
  readonly trial_id: Uuid4;
  readonly value: JsonValue;
}

/** A compared field whose values differ; `declared` differences are part of the strategies. */
export interface ProjectionDifference {
  readonly field: string;
  readonly declared: boolean;
  readonly values: readonly ProjectedFieldValue[];
}

/** One equality projection (design §8.14 table); it fails only on an undeclared difference. */
export interface EqualityProjection {
  readonly projection_id: EqualityProjectionId;
  readonly result: PreservationVerdict;
  readonly compared_fields: readonly string[];
  readonly differences: readonly ProjectionDifference[];
  readonly evidence_refs: readonly EvidenceRef[];
}

/** One eligibility condition and whether it holds. */
export interface ComparisonCheck {
  readonly check_id: ComparisonCheckId;
  readonly holds: boolean;
  readonly reasons: readonly StructuredReason[];
}

type EightProjections = readonly [
  EqualityProjection,
  EqualityProjection,
  EqualityProjection,
  EqualityProjection,
  EqualityProjection,
  EqualityProjection,
  EqualityProjection,
  EqualityProjection,
];
type NineChecks = readonly [
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
];

interface ComparisonAssessmentFields extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'comparison_assessment';
  readonly run_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  /** The oracle results the comparison read, in declared trial order (at most four). */
  readonly oracle_result_refs: readonly ArtifactRef[];
  readonly equality_projections: EightProjections;
  /** `pass` iff every projection passes; `indeterminate` when an input was missing. */
  readonly equality_result: PreservationVerdict;
  readonly eligibility_checks: NineChecks;
  readonly assessed_at: UtcMillis;
}

/** Schema: `schemas/group-c/comparison_assessment.schema.json`. */
export type ComparisonAssessment = ComparisonAssessmentFields & ComparisonEligibilityOutcome;
