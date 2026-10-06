// The validation summary the runner freezes at phase P9 (BR-RUA-038; design §6.3, §10.2): one
// variant, the two declared trials in their only order (CONTROL, then COMMIT_THEN_TIMEOUT), each
// mapped one to one from the manifest, the canonical terminal reason, the declared status with its
// reasons, and the operational status fields. It has no `run_id` and no cross-variant field: a
// validation makes no BR-RUA-007 or comparison conclusion.

import type { Sha256Hex, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { DeclaredTrial, ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { OracleResult } from '../record-contract/records/group-c/oracle_result.ts';
import type { SafetyAssessment } from '../record-contract/records/group-c/safety_assessment.ts';
import type {
  ArtifactRef,
  EvaluatedTrialResult,
  SummaryTrialResult,
  UnevaluatedTrialResult,
} from '../record-contract/records/group-c/shared-shapes.ts';
import type { ValidationSummary } from '../record-contract/records/group-c/validation_summary.ts';
import type {
  ApplicableGateValue,
  LateEvidenceStatus,
  TrialExecutionStatus,
  ValidationTerminalReason,
} from '../record-contract/records/group-c/vocabulary.ts';
import type { OriginalClosure } from '../evidence-package/effective-operational-state.ts';
import { PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { assessSafetyStanding } from './safety-standing.ts';
import { assessScientificEvidence } from './scientific-evidence.ts';
import type { TrialEvidence } from './scientific-evidence.ts';
import { deriveValidationStatus } from './validation-status.ts';
import type { ValidationReason } from './validation-reasons.ts';

/** The frozen manifest of a variant validation. */
export type ValidationManifest = Extract<ExecutionManifest, { readonly execution_kind: 'VARIANT_VALIDATION' }>;

/** A declared trial that was frozen with an oracle result (completed, or interrupted and frozen). */
export interface EvaluatedTrialOutcome {
  readonly kind: 'evaluated';
  readonly execution_status: TrialExecutionStatus;
  readonly incompletion_reasons: readonly StructuredReason[];
  readonly oracle_result: OracleResult;
  /** Path and digest of the stored `derived/oracle-result.json` bytes. */
  readonly oracle_result_ref: ArtifactRef;
  /** Digest of the stored trial-manifest bytes; `undefined` when it was never frozen. */
  readonly trial_manifest_sha256: Sha256Hex | undefined;
  /** Why the result is not covered by its anchors (for example no evidence index); empty when it is. */
  readonly anchor_problems: readonly string[];
}

/** A declared trial that could not start or could not be frozen (D-29). */
export interface UnevaluatedTrialOutcome {
  readonly kind: 'unevaluated';
  readonly execution_status: 'incomplete' | 'not_started';
  readonly incompletion_reasons: readonly [StructuredReason, ...StructuredReason[]];
}

export type ValidationTrialOutcome = EvaluatedTrialOutcome | UnevaluatedTrialOutcome;

export interface ValidationSummaryInput {
  readonly manifest: ValidationManifest;
  /** Digest of the frozen execution-manifest bytes. */
  readonly execution_manifest_sha256: Sha256Hex;
  /** One outcome per declared trial, in declared order. */
  readonly trials: readonly [ValidationTrialOutcome, ValidationTrialOutcome];
  /** Scientific defects found outside the trials, such as invalid admission (admission-evidence.ts). */
  readonly scientific_defects: readonly ValidationReason[];
  readonly terminal_reason: ValidationTerminalReason;
  readonly closure: OriginalClosure;
  readonly safety: SafetyAssessment;
  readonly evidence_integrity_status: ApplicableGateValue;
  readonly late_evidence_status: LateEvidenceStatus;
  readonly cleanup_result_ref: ArtifactRef;
  readonly late_evidence_assessment_ref: ArtifactRef;
  readonly created_at: UtcMillis;
}

/**
 * Builds the validation summary and derives its declared status (BR-RUA-038 precedence).
 *
 * @example
 * const summary = buildValidationSummary({ manifest, execution_manifest_sha256, trials: [control, treatment],
 *   scientific_defects: admission.defects,
 *   terminal_reason: 'COMPLETED', closure, safety, evidence_integrity_status: 'verified',
 *   late_evidence_status: 'none', cleanup_result_ref, late_evidence_assessment_ref, created_at });
 * summary.implementation_validation_status; // 'verified' for control pass and a conclusive treatment
 */
export function buildValidationSummary(input: ValidationSummaryInput): ValidationSummary {
  const { manifest } = input;
  const [control, treatment] = manifest.trials;
  const [controlOutcome, treatmentOutcome] = input.trials;
  const scientific = assessScientificEvidence({
    variant_validation_id: manifest.variant_validation_id,
    variant_id: manifest.variant_id,
    execution_manifest_sha256: input.execution_manifest_sha256,
    trials: [trialEvidence(control, controlOutcome), trialEvidence(treatment, treatmentOutcome)],
    defects: input.scientific_defects,
  });
  const status = deriveValidationStatus({
    scientific,
    terminal_reason: input.terminal_reason,
    closure: input.closure,
    closure_basis: 'declared',
    safety: assessSafetyStanding(input.safety),
    late_evidence_status: input.late_evidence_status,
    evidence_integrity_status: input.evidence_integrity_status,
  });
  return {
    schema_version: 1,
    record_type: 'validation_summary',
    variant_validation_id: manifest.variant_validation_id,
    variant_id: manifest.variant_id,
    execution_manifest_sha256: input.execution_manifest_sha256,
    trial_results: [summaryEntry(control, controlOutcome), summaryEntry(treatment, treatmentOutcome)],
    validation_terminal_reason: input.terminal_reason,
    validation_validity: status.validation_validity,
    implementation_validation_status: status.implementation_validation_status,
    status_reasons: status.reasons,
    cleanup_status: input.closure.cleanup_status,
    leak_audit_status: input.closure.leak_audit_status,
    lease_status: input.closure.lease_status,
    safety_status: input.safety.safety_status,
    evidence_integrity_status: input.evidence_integrity_status,
    late_evidence_status: input.late_evidence_status,
    cleanup_result_ref: input.cleanup_result_ref,
    late_evidence_assessment_ref: input.late_evidence_assessment_ref,
    created_at: input.created_at,
  };
}

function trialEvidence(declared: DeclaredTrial, outcome: ValidationTrialOutcome): TrialEvidence {
  if (outcome.kind === 'evaluated') {
    return {
      kind: 'frozen',
      declared,
      oracle_result: outcome.oracle_result,
      trial_manifest_sha256: outcome.trial_manifest_sha256,
      anchor_problems: outcome.anchor_problems,
    };
  }
  return {
    kind: 'missing',
    declared,
    artifact_path: PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: declared.trial_id }, 'oracleResult'),
    detail: `trial ${declared.trial_id} is ${outcome.execution_status} without an oracle result; expected a frozen oracle result`,
  };
}

function summaryEntry(declared: DeclaredTrial, outcome: ValidationTrialOutcome): SummaryTrialResult {
  const head = {
    sequence: declared.sequence,
    trial_id: declared.trial_id,
    variant_id: declared.variant_id,
    scenario: declared.scenario,
  };
  if (outcome.kind === 'unevaluated') {
    const entry: UnevaluatedTrialResult = {
      ...head,
      execution_status: outcome.execution_status,
      incompletion_reasons: outcome.incompletion_reasons,
    };
    return entry;
  }
  const entry: EvaluatedTrialResult = {
    ...head,
    execution_status: outcome.execution_status,
    oracle_result_ref: outcome.oracle_result_ref,
    preservation_verdict: outcome.oracle_result.preservation_verdict,
    correct_completion: outcome.oracle_result.correct_completion,
    incompletion_reasons: outcome.incompletion_reasons,
  };
  return entry;
}
