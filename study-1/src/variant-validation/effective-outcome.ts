// The CTR-RUA-004 outcome fields of a variant-validation verification. A conclusive effective
// status (`verified` or `failed`) is only ever emitted together with an eligible package, a valid
// validation and a clean effective closure; the status derivation already guarantees that, and
// this module states it in the record's type by checking every field before it builds the
// conclusive branch. A candidate that does not meet them is `indeterminate`, with one reason per
// unmet field, so the record never claims a conclusion its own fields contradict.

import type { EffectiveValidationOutcome } from '../record-contract/records/group-c/variant_validation_verification.ts';
import type {
  Eligibility,
  ImplementationValidationStatus,
  TrialValidity,
} from '../record-contract/records/group-c/vocabulary.ts';
import type { EffectiveOperationalState } from '../evidence-package/effective-operational-state.ts';
import { validationReason } from './validation-reasons.ts';
import type { ValidationReason } from './validation-reasons.ts';

export interface EffectiveOutcomeCandidate {
  readonly status: ImplementationValidationStatus;
  readonly reasons: readonly ValidationReason[];
  readonly package_eligibility: Eligibility;
  readonly validation_validity: TrialValidity;
  readonly state: EffectiveOperationalState;
}

/** The outcome fields of the record, and the reasons that go with them. */
export interface EffectiveOutcome {
  readonly outcome: EffectiveValidationOutcome;
  readonly reasons: readonly ValidationReason[];
}

/**
 * Builds the outcome fields, downgrading a conclusive candidate whose fields are not all met.
 *
 * @example
 * effectiveOutcome({ status: 'verified', reasons: [], package_eligibility: 'eligible',
 *   validation_validity: 'valid', state }).outcome.effective_implementation_validation_status; // 'verified'
 */
export function effectiveOutcome(candidate: EffectiveOutcomeCandidate): EffectiveOutcome {
  const { state, status } = candidate;
  const unmet = unmetConclusiveFields(candidate);
  if ((status === 'verified' || status === 'failed') && unmet.length === 0) {
    return {
      outcome: {
        effective_implementation_validation_status: status,
        package_eligibility: 'eligible',
        validation_validity: 'valid',
        effective_cleanup_status: 'succeeded',
        effective_leak_audit_status: 'clean',
        effective_lease_status: 'released',
      },
      reasons: candidate.reasons,
    };
  }
  const reasons = status === 'indeterminate' ? candidate.reasons : unmet;
  return {
    outcome: {
      effective_implementation_validation_status: 'indeterminate',
      package_eligibility: candidate.package_eligibility,
      validation_validity: candidate.validation_validity,
      effective_cleanup_status: state.effective_cleanup_status,
      effective_leak_audit_status: state.effective_leak_audit_status,
      effective_lease_status: state.effective_lease_status,
    },
    reasons,
  };
}

function unmetConclusiveFields(candidate: EffectiveOutcomeCandidate): readonly ValidationReason[] {
  const { state } = candidate;
  const checks: readonly (readonly [boolean, ValidationReason])[] = [
    [
      candidate.package_eligibility === 'eligible',
      unmet('PACKAGE_INELIGIBLE', 'package_eligibility', candidate.package_eligibility, 'eligible'),
    ],
    [
      candidate.validation_validity === 'valid',
      unmet('TRIAL_NOT_VALID', 'validation_validity', candidate.validation_validity, 'valid'),
    ],
    [
      state.effective_cleanup_status === 'succeeded',
      unmet('CLEANUP_NOT_SUCCEEDED', 'effective_cleanup_status', state.effective_cleanup_status, 'succeeded'),
    ],
    [
      state.effective_leak_audit_status === 'clean',
      unmet('LEAK_AUDIT_NOT_CLEAN', 'effective_leak_audit_status', state.effective_leak_audit_status, 'clean'),
    ],
    [
      state.effective_lease_status === 'released',
      unmet('LEASE_NOT_RELEASED', 'effective_lease_status', state.effective_lease_status, 'released'),
    ],
  ];
  return checks.filter(([met]) => !met).map(([, reason]) => reason);
}

function unmet(code: ValidationReason['code'], field: string, observed: string, expected: string): ValidationReason {
  return validationReason(code, field, `${field} is ${observed}; expected ${expected} for a conclusive status`);
}
