// Catalogue group C row 74 (design §6.2, §8.17): every safety check of one execution and the
// derived status, with precedence `breached > unverified > within_limits` (BR-RUA-046).

import type { EvidenceRef } from '../../evidence-refs.ts';
import type { Sha256Hex, StructuredReason, UtcMillis } from '../../primitives.ts';
import type { SafetyBoundary, SafetyResult } from '../group-b/vocabulary.ts';
import type { ExecutionCorrelation, ExecutionScoped } from './shared-shapes.ts';

/** One check: boundary, declared limit, observed value when available, result, evidence, time. */
export interface SafetyCheck {
  readonly boundary: SafetyBoundary;
  readonly declared_limit: string;
  readonly observed?: string;
  readonly result: SafetyResult;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly checked_at: UtcMillis;
}

interface SafetyAssessmentFields extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'safety_assessment';
  readonly execution_manifest_sha256: Sha256Hex;
  readonly safety_status: SafetyResult;
  readonly checks: readonly [SafetyCheck, ...SafetyCheck[]];
  readonly reasons: readonly StructuredReason[];
  readonly assessed_at: UtcMillis;
}

/** Schema: `schemas/group-c/safety_assessment.schema.json`. */
export type SafetyAssessment = ExecutionCorrelation & SafetyAssessmentFields;
