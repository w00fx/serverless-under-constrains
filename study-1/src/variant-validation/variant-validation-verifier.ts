// The CTR-RUA-004 variant-validation verifier (BR-RUA-038, BR-RUA-044; design §8.15; AC-RUA-025,
// AC-RUA-026, AC-RUA-035, AC-RUA-036, AC-RUA-037). It reads an original validation package and its
// explicitly selected amendment chain and states the effective implementation-validation status:
// 1. the package verifier judges structure, integrity and the selected chain (eligibility);
// 2. the original scientific evidence is read back from the original bytes (admission, manifest
//    drift, both trials' oracle results and their anchors); no amendment can change it;
// 3. the declared status is re-derived from the original values with the BR-RUA-038 precedence; a
//    summary whose status or validity disagrees is contradicted, so nothing it claims is trusted;
// 4. the effective operational values come from the OPERATIONAL_RECOVERY amendments of the
//    selected chain (effective-operational-state.ts), the only values recovery may repair;
// 5. the effective status applies the same precedence to the effective values, with the safety
//    standing a selected BILLING amendment may change; any package ineligibility or contradiction
//    makes it `indeterminate`.
// The original summary and every original file are only read, never rewritten (AC-RUA-026). The
// record is written outside the package (`verifications/`), so every reference pins its package
// index digest (BR-RUA-035).

import { sortEvidenceRefs } from '../record-contract/evidence-refs.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, Uuid4, UtcMillis } from '../record-contract/primitives.ts';
import type { PackageVerification } from '../record-contract/records/group-c/package_verification.ts';
import type { SafetyAssessment } from '../record-contract/records/group-c/safety_assessment.ts';
import type { CrossPackageRef } from '../record-contract/records/group-c/shared-shapes.ts';
import type { ValidationSummary } from '../record-contract/records/group-c/validation_summary.ts';
import type { VariantValidationVerification } from '../record-contract/records/group-c/variant_validation_verification.ts';
import type { AmendmentSnapshot } from '../evidence-package/amendment-snapshots.ts';
import { effectiveOperationalState } from '../evidence-package/effective-operational-state.ts';
import type { EffectiveOperationalState } from '../evidence-package/effective-operational-state.ts';
import { AMENDMENT_PATHS, EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { verifyPackage } from '../evidence-package/package-verifier.ts';
import type { PackageSnapshot, PackageVerifierDeps } from '../evidence-package/package-verifier.ts';
import { readAdmissionEvidence } from './admission-evidence.ts';
import { billedSafetyStanding } from './billing-safety.ts';
import { effectiveOutcome } from './effective-outcome.ts';
import { readPackageTrialEvidence } from './package-trial-evidence.ts';
import { assessSafetyStanding } from './safety-standing.ts';
import type { SafetyStanding } from './safety-standing.ts';
import { assessScientificEvidence } from './scientific-evidence.ts';
import type { ScientificAssessment } from './scientific-evidence.ts';
import { readValidationRecord } from './validation-records.ts';
import { validationReason } from './validation-reasons.ts';
import type { ValidationReason } from './validation-reasons.ts';
import { deriveValidationStatus } from './validation-status.ts';
import type { ClosureBasis, ClosureValues, ValidationStatus } from './validation-status.ts';

export interface VariantValidationVerifierInput {
  readonly variant_validation_id: Uuid4;
  readonly original: PackageSnapshot;
  /** Every amendment directory found for the validation, selected or not. */
  readonly amendments: readonly AmendmentSnapshot[];
  /** The amendment-index digest the operator selected, or `null` for the original package alone. */
  readonly selected_head: Sha256Hex | null;
  /** Package-index digests that cross-package references may name. */
  readonly referenced_package_indexes: readonly Sha256Hex[];
  readonly checked_at: UtcMillis;
}

/** The services the verifier uses: the catalogue validator and the byte digest (production: `sha256Hex`). */
export type VariantValidationVerifierDeps = PackageVerifierDeps;

interface StatusInputs {
  readonly scientific: ScientificAssessment;
  readonly summary: ValidationSummary;
}

/**
 * Verifies a variant validation. Total over arbitrary package bytes: every defect is a reason. It
 * is an error only when there is no readable summary of this validation, since then there is no
 * declared status to verify.
 *
 * @example
 * const verification = verifyVariantValidation(
 *   { variant_validation_id, original, amendments, selected_head, referenced_package_indexes: [], checked_at },
 *   { validator, digest: sha256Hex },
 * );
 * if (verification.ok) verification.value.effective_implementation_validation_status; // 'verified' | ...
 */
export function verifyVariantValidation(
  input: VariantValidationVerifierInput,
  deps: VariantValidationVerifierDeps,
): Result<VariantValidationVerification, ValidationReason> {
  const { files } = input.original;
  const summaryPath = EXECUTION_PATHS.validationSummary;
  const summaryRead = readValidationRecord(files, summaryPath, 'validation_summary', deps.validator);
  if (!summaryRead.ok) {
    return err(validationReason('SCIENTIFIC_EVIDENCE_MISSING', 'validation summary', summaryRead.error, summaryPath));
  }
  const summary = summaryRead.value.record;
  if (summary.variant_validation_id !== input.variant_validation_id) {
    const detail = `${summaryPath} summarizes validation ${summary.variant_validation_id}; expected ${input.variant_validation_id}`;
    return err(validationReason('MANIFEST_DRIFT', 'validation summary', detail, summaryPath));
  }
  const verification = verifyPackage(
    {
      identity: { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: input.variant_validation_id },
      original: input.original,
      amendments: input.amendments,
      selected_head: input.selected_head,
      referenced_package_indexes: input.referenced_package_indexes,
      evaluated_at: input.checked_at,
    },
    deps,
  );
  const inputs: StatusInputs = { scientific: scientificAssessment(input, summary, deps), summary };
  const originalSafety = assessSafetyStanding(safetyAssessmentOf(input, deps));
  const declared = deriveStatus(inputs, summary, 'declared', originalSafety);
  const state = effectiveOperationalState(
    { verification, original_closure: summary, amendments: input.amendments },
    deps,
  );
  const effectiveClosure: ClosureValues = {
    cleanup_status: state.effective_cleanup_status,
    leak_audit_status: state.effective_leak_audit_status,
    lease_status: state.effective_lease_status,
  };
  const safety = billedSafetyStanding(originalSafety, verification, input.amendments, deps);
  const effective = deriveStatus(inputs, effectiveClosure, 'effective', safety);
  const blocking = [...eligibilityReasons(verification), ...contradictionReasons(summary, declared)];
  const outcome = effectiveOutcome({
    status: blocking.length > 0 ? 'indeterminate' : effective.implementation_validation_status,
    reasons: blocking.length > 0 ? [...blocking, ...unmetReasons(effective)] : effective.reasons,
    package_eligibility: verification.package_eligibility,
    validation_validity: effective.validation_validity,
    state,
  });
  const summaryRef: CrossPackageRef = {
    artifact_path: summaryPath,
    artifact_sha256: deps.digest(summaryRead.value.bytes),
    package_index_sha256: verification.original_package_index_sha256,
  };
  return ok({
    schema_version: 1,
    record_type: 'variant_validation_verification',
    variant_validation_id: input.variant_validation_id,
    validation_summary_ref: summaryRef,
    original_package_index_sha256: verification.original_package_index_sha256,
    selected_amendment_head_sha256: verification.selected_amendment_head_sha256,
    declared_implementation_validation_status: summary.implementation_validation_status,
    ...outcome.outcome,
    operational_recovery_applied: state.operational_recovery_applied,
    effective_status_reasons: outcome.reasons,
    evidence_refs: evidenceRefs(summaryRef, summary, verification, state),
    checked_at: input.checked_at,
  });
}

function scientificAssessment(
  input: VariantValidationVerifierInput,
  summary: ValidationSummary,
  deps: VariantValidationVerifierDeps,
): ScientificAssessment {
  const { files } = input.original;
  const admission = readAdmissionEvidence(files, input.variant_validation_id, deps);
  if (!admission.ok) {
    return {
      validation_validity: 'invalid',
      reasons: [admission.error],
      control_verdict: undefined,
      treatment_verdict: undefined,
    };
  }
  return assessScientificEvidence(readPackageTrialEvidence({ files, admission: admission.value, summary }, deps));
}

function safetyAssessmentOf(
  input: VariantValidationVerifierInput,
  deps: VariantValidationVerifierDeps,
): SafetyAssessment | undefined {
  const read = readValidationRecord(
    input.original.files,
    EXECUTION_PATHS.safetyAssessment,
    'safety_assessment',
    deps.validator,
  );
  return read.ok ? read.value.record : undefined;
}

function deriveStatus(
  inputs: StatusInputs,
  closure: ClosureValues,
  basis: ClosureBasis,
  safety: SafetyStanding,
): ValidationStatus {
  const { summary } = inputs;
  return deriveValidationStatus({
    scientific: inputs.scientific,
    terminal_reason: summary.validation_terminal_reason,
    closure,
    closure_basis: basis,
    safety,
    late_evidence_status: summary.late_evidence_status,
    evidence_integrity_status: summary.evidence_integrity_status,
  });
}

function eligibilityReasons(verification: PackageVerification): readonly ValidationReason[] {
  if (verification.package_eligibility === 'eligible') {
    return [];
  }
  const codes = verification.package_ineligibility_reasons.map((reason) => reason.code).join(', ');
  return [
    validationReason(
      'PACKAGE_INELIGIBLE',
      'package_eligibility',
      `the package verifier finds the package ineligible (${codes}); expected an eligible package and selected chain`,
    ),
  ];
}

function contradictionReasons(summary: ValidationSummary, declared: ValidationStatus): readonly ValidationReason[] {
  if (
    summary.implementation_validation_status === declared.implementation_validation_status &&
    summary.validation_validity === declared.validation_validity
  ) {
    return [];
  }
  return [
    validationReason(
      'DECLARED_STATUS_CONTRADICTED',
      'validation summary',
      `the summary declares ${summary.implementation_validation_status} (${summary.validation_validity}); its original evidence derives ${declared.implementation_validation_status} (${declared.validation_validity})`,
      EXECUTION_PATHS.validationSummary,
    ),
  ];
}

/** The unmet conditions of a derivation; a conclusive one has none (its reason states a verdict). */
function unmetReasons(status: ValidationStatus): readonly ValidationReason[] {
  return status.implementation_validation_status === 'indeterminate' ? status.reasons : [];
}

function evidenceRefs(
  summaryRef: CrossPackageRef,
  summary: ValidationSummary,
  verification: PackageVerification,
  state: EffectiveOperationalState,
): readonly EvidenceRef[] {
  const resultRefs = summary.trial_results.flatMap((entry) =>
    'oracle_result_ref' in entry
      ? [{ ...entry.oracle_result_ref, package_index_sha256: verification.original_package_index_sha256 }]
      : [],
  );
  const recoveries = state.operational_recovery_applied ? recoveryRefs(verification) : [];
  return sortEvidenceRefs([summaryRef, ...resultRefs, ...recoveries]);
}

// A recovery is cited by its amendment index, which lists the recovery record by digest, so the
// reference pins the whole amendment without re-reading a payload the state derivation already read.
function recoveryRefs(verification: PackageVerification): readonly EvidenceRef[] {
  return verification.selected_chain
    .filter((link) => link.amendment_kind === 'OPERATIONAL_RECOVERY')
    .map((link) => ({
      artifact_path: AMENDMENT_PATHS.amendmentIndex,
      artifact_sha256: link.amendment_index_sha256,
      package_index_sha256: link.amendment_index_sha256,
    }));
}
