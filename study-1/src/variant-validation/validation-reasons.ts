// The closed reason vocabulary of the variant-validation status and its verifier (BR-RUA-038,
// CTR-RUA-004; design §8.15). Every condition that keeps a validation from `verified` adds one
// reason with its own code, so a reader of `status_reasons` or `effective_status_reasons` sees
// which acceptance condition failed, the offending value and the expected one (clean-code rule).
//
// The codes split in three groups:
// - scientific: what the original frozen evidence says; operational recovery never repairs them;
// - closure: cleanup, leak-audit and lease closure, the only values recovery may repair;
// - verifier: conditions only CTR-RUA-004 judges (package eligibility, a contradicted summary).

import type { StructuredReason } from '../record-contract/primitives.ts';

/** Reason codes of BR-RUA-038 and CTR-RUA-004, in the order the derivation reports them. */
export const VALIDATION_REASON_CODES = [
  'PACKAGE_INELIGIBLE',
  'ADMISSION_INVALID',
  'MANIFEST_DRIFT',
  'SCIENTIFIC_EVIDENCE_MISSING',
  'CRYPTOGRAPHIC_ANCHOR_MISSING',
  'TRIAL_NOT_VALID',
  'CONTROL_INTEGRITY_NOT_VERIFIED',
  'TREATMENT_FIDELITY_NOT_VERIFIED',
  'CONTROL_VERDICT_INDETERMINATE',
  'TREATMENT_VERDICT_INDETERMINATE',
  'EVIDENCE_INTEGRITY_NOT_VERIFIED',
  'LATE_EVIDENCE_CONTRADICTORY',
  'LATE_EVIDENCE_UNVERIFIED',
  'SAFETY_BREACHED',
  'SAFETY_UNVERIFIED',
  'TERMINAL_REASON_NOT_COMPLETED',
  'CLEANUP_NOT_SUCCEEDED',
  'LEAK_AUDIT_NOT_CLEAN',
  'LEASE_NOT_RELEASED',
  'DECLARED_STATUS_CONTRADICTED',
  'CONTROL_PRESERVATION_FAILED',
] as const;
export type ValidationReasonCode = (typeof VALIDATION_REASON_CODES)[number];

/** A structured reason whose code is one of `VALIDATION_REASON_CODES`. */
export type ValidationReason = StructuredReason & { readonly code: ValidationReasonCode };

/**
 * Builds one validation reason; `detail` states the offending value and the expected shape.
 *
 * @example
 * validationReason('CLEANUP_NOT_SUCCEEDED', 'cleanup_status', 'cleanup_status is partial; expected succeeded');
 */
export function validationReason(
  code: ValidationReasonCode,
  subject: string,
  detail: string,
  artifactPath?: string,
): ValidationReason {
  return artifactPath === undefined
    ? { code, subject, detail }
    : { code, subject, artifact_path: artifactPath, detail };
}
