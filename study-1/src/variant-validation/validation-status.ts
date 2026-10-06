// BR-RUA-038 status precedence (design §8.15), shared by the summary the runner freezes and by the
// CTR-RUA-004 verifier:
//
//   indeterminate  if any acceptance condition is unresolved, unusable, unsafe, incomplete,
//                  non-clean or indeterminate (scientific conditions, evidence integrity, late
//                  evidence, safety, terminal reason, cleanup, leak audit, lease);
//   failed         elif the trustworthy control verdict is `fail`;
//   verified       elif the control verdict is `pass` and the treatment verdict is `pass` or `fail`.
//
// The verifier applies the same precedence to the effective operational values (CTR-RUA-004).
// Recovery may repair only cleanup, leak-audit and lease closure, so with `effective` values a
// terminal reason that names one of those closures is judged by the repaired values instead; every
// other terminal reason stays a nonrecoverable condition.

import type { ValidationTerminalReason } from '../record-contract/records/group-c/vocabulary.ts';
import type {
  ApplicableGateValue,
  CleanupStatus,
  EffectiveCleanupStatus,
  EffectiveLeakAuditStatus,
  ImplementationValidationStatus,
  LateEvidenceStatus,
  LeaseStatus,
  TrialValidity,
} from '../record-contract/records/group-c/vocabulary.ts';
import { safetyReasons } from './safety-standing.ts';
import type { SafetyStanding } from './safety-standing.ts';
import type { ScientificAssessment } from './scientific-evidence.ts';
import { validationReason } from './validation-reasons.ts';
import type { ValidationReason } from './validation-reasons.ts';

/** Cleanup, leak-audit and lease closure as frozen (`declared`) or after recovery (`effective`). */
export interface ClosureValues {
  readonly cleanup_status: CleanupStatus | EffectiveCleanupStatus;
  readonly leak_audit_status: EffectiveLeakAuditStatus;
  readonly lease_status: LeaseStatus;
}

/** Whether the closure values are the original summary's or the effective ones of CTR-RUA-004. */
export type ClosureBasis = 'declared' | 'effective';

export interface ValidationStatusInput {
  readonly scientific: ScientificAssessment;
  readonly terminal_reason: ValidationTerminalReason;
  readonly closure: ClosureValues;
  readonly closure_basis: ClosureBasis;
  readonly safety: SafetyStanding;
  readonly late_evidence_status: LateEvidenceStatus;
  readonly evidence_integrity_status: ApplicableGateValue;
}

export interface ValidationStatus {
  readonly validation_validity: TrialValidity;
  readonly implementation_validation_status: ImplementationValidationStatus;
  /** Every unmet condition; for `failed`, the control failure; empty only for `verified`. */
  readonly reasons: readonly ValidationReason[];
}

/** Terminal reasons that name only a closure operational recovery may repair (BR-RUA-038). */
export const REPAIRABLE_TERMINAL_REASONS: readonly ValidationTerminalReason[] = [
  'CLEANUP_INCOMPLETE',
  'LEAK_AUDIT_NOT_CLEAN',
  'LEASE_RELEASE_FAILED',
  'LEASE_STATE_UNVERIFIED',
];

/**
 * Derives validation validity, implementation-validation status and its reasons.
 *
 * @example
 * deriveValidationStatus({ scientific, terminal_reason: 'COMPLETED', closure: { cleanup_status: 'succeeded',
 *   leak_audit_status: 'clean', lease_status: 'released' }, closure_basis: 'declared',
 *   safety: { standing: 'within_limits' }, late_evidence_status: 'none', evidence_integrity_status: 'verified' });
 * // { validation_validity: 'valid', implementation_validation_status: 'verified', reasons: [] }
 */
export function deriveValidationStatus(input: ValidationStatusInput): ValidationStatus {
  const unmet = [
    ...input.scientific.reasons,
    ...integrityReasons(input.evidence_integrity_status),
    ...lateEvidenceReasons(input.late_evidence_status),
    ...safetyReasons(input.safety),
    ...terminalReasons(input.terminal_reason, input.closure_basis),
    ...closureReasons(input.closure),
  ];
  const validity = input.scientific.validation_validity;
  const { control_verdict: control, treatment_verdict: treatment } = input.scientific;
  if (unmet.length > 0) {
    return { validation_validity: validity, implementation_validation_status: 'indeterminate', reasons: unmet };
  }
  const treatmentConclusive = treatment === 'pass' || treatment === 'fail';
  if (control === 'fail' && treatmentConclusive) {
    const failed = validationReason(
      'CONTROL_PRESERVATION_FAILED',
      'trial 1 (CONTROL)',
      'the trustworthy control preservation verdict is fail; expected pass',
    );
    return { validation_validity: validity, implementation_validation_status: 'failed', reasons: [failed] };
  }
  if (control === 'pass' && treatmentConclusive) {
    return { validation_validity: validity, implementation_validation_status: 'verified', reasons: [] };
  }
  // Only a caller-built assessment that omits the verdict reasons reaches here; the status still
  // names why it is not conclusive (an indeterminate status always carries a reason).
  const inconclusive = validationReason(
    control === 'pass' || control === 'fail' ? 'TREATMENT_VERDICT_INDETERMINATE' : 'CONTROL_VERDICT_INDETERMINATE',
    'preservation_verdict',
    `control verdict ${control ?? 'absent'} and treatment verdict ${treatment ?? 'absent'}; expected conclusive verdicts`,
  );
  return { validation_validity: validity, implementation_validation_status: 'indeterminate', reasons: [inconclusive] };
}

function integrityReasons(status: ApplicableGateValue): readonly ValidationReason[] {
  return status === 'verified'
    ? []
    : [
        validationReason(
          'EVIDENCE_INTEGRITY_NOT_VERIFIED',
          'evidence_integrity_status',
          `evidence_integrity_status is ${status}; expected verified`,
        ),
      ];
}

function lateEvidenceReasons(status: LateEvidenceStatus): readonly ValidationReason[] {
  if (status === 'none' || status === 'consistent') {
    return [];
  }
  const code = status === 'contradictory' ? 'LATE_EVIDENCE_CONTRADICTORY' : 'LATE_EVIDENCE_UNVERIFIED';
  return [
    validationReason(code, 'late_evidence_status', `late_evidence_status is ${status}; expected none or consistent`),
  ];
}

function terminalReasons(reason: ValidationTerminalReason, basis: ClosureBasis): readonly ValidationReason[] {
  if (reason === 'COMPLETED' || (basis === 'effective' && REPAIRABLE_TERMINAL_REASONS.includes(reason))) {
    return [];
  }
  return [
    validationReason(
      'TERMINAL_REASON_NOT_COMPLETED',
      'validation_terminal_reason',
      `validation_terminal_reason is ${reason}; expected COMPLETED`,
    ),
  ];
}

function closureReasons(closure: ClosureValues): readonly ValidationReason[] {
  const reasons: ValidationReason[] = [];
  if (closure.cleanup_status !== 'succeeded') {
    reasons.push(
      validationReason(
        'CLEANUP_NOT_SUCCEEDED',
        'cleanup_status',
        `cleanup_status is ${closure.cleanup_status}; expected succeeded`,
      ),
    );
  }
  if (closure.leak_audit_status !== 'clean') {
    reasons.push(
      validationReason(
        'LEAK_AUDIT_NOT_CLEAN',
        'leak_audit_status',
        `leak_audit_status is ${closure.leak_audit_status}; expected clean`,
      ),
    );
  }
  if (closure.lease_status !== 'released') {
    reasons.push(
      validationReason(
        'LEASE_NOT_RELEASED',
        'lease_status',
        `lease_status is ${closure.lease_status}; expected released`,
      ),
    );
  }
  return reasons;
}
