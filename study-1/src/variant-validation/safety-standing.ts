// How the safety assessment of a variant validation bears on its status (BR-RUA-038, BR-RUA-046,
// OR-RUA-005; design §8.15). A known breach always makes the status `indeterminate`. An unverified
// assessment does too, with one exception OR-RUA-005 states: a billed-cost check left unverified
// by delayed or incomplete billing data does not block verification "when the admission estimate
// was within its ceiling, every real-time duration and resource safeguard remained within limits,
// and no other safety uncertainty exists".
//
// A safety check carries no reason of its own, so the exception is judged per boundary
// (evidence/WP-17/decisions.md): every unverified check is `BILLED_COST`, at least one is, and the
// estimate (`ESTIMATED_COST`) and the real-time duration safeguards (`ACTIVE_TIME`, `TOTAL_TIME`)
// are recorded and within limits. Any other unverified boundary, or a missing required one, is
// other safety uncertainty.

import type { SafetyBoundary } from '../record-contract/records/group-b/vocabulary.ts';
import type { SafetyAssessment, SafetyCheck } from '../record-contract/records/group-c/safety_assessment.ts';
import { validationReason } from './validation-reasons.ts';
import type { ValidationReason } from './validation-reasons.ts';

/** The status input a safety assessment yields. */
export type SafetyStanding =
  | { readonly standing: 'within_limits' }
  /** OR-RUA-005: only the billed-cost check is unverified, every real-time safeguard held. */
  | { readonly standing: 'billing_pending' }
  | { readonly standing: 'breached' | 'unverified'; readonly reasons: readonly ValidationReason[] };

/** The boundaries OR-RUA-005 requires within limits before a pending bill is tolerated. */
export const REAL_TIME_SAFEGUARDS: readonly SafetyBoundary[] = ['ESTIMATED_COST', 'ACTIVE_TIME', 'TOTAL_TIME'];

const SUBJECT = 'safety_status';

/**
 * Judges a safety assessment; `undefined` means no readable assessment exists, which is itself an
 * unresolved safety condition.
 *
 * @example
 * assessSafetyStanding(withinLimitsAssessment); // { standing: 'within_limits' }
 * assessSafetyStanding(undefined).standing; // 'unverified'
 */
export function assessSafetyStanding(assessment: SafetyAssessment | undefined): SafetyStanding {
  if (assessment === undefined) {
    return unverified([
      validationReason(
        'SAFETY_UNVERIFIED',
        SUBJECT,
        'no readable safety assessment; expected summary/safety-assessment.json',
      ),
    ]);
  }
  const breached = breachReasons(assessment);
  if (breached.length > 0) {
    return { standing: 'breached', reasons: breached };
  }
  const pending = assessment.checks.filter((check) => check.result === 'unverified');
  if (assessment.safety_status === 'within_limits' && pending.length === 0) {
    return { standing: 'within_limits' };
  }
  const uncertainty = otherUncertainty(assessment.checks, pending);
  return uncertainty.length === 0 ? { standing: 'billing_pending' } : unverified(uncertainty);
}

/**
 * The reasons a standing adds to a status derivation: none for `within_limits` and
 * `billing_pending`.
 *
 * @example
 * safetyReasons({ standing: 'billing_pending' }); // []
 */
export function safetyReasons(standing: SafetyStanding): readonly ValidationReason[] {
  return standing.standing === 'breached' || standing.standing === 'unverified' ? standing.reasons : [];
}

function breachReasons(assessment: SafetyAssessment): readonly ValidationReason[] {
  const checks = assessment.checks.filter((check) => check.result === 'breached');
  const perCheck = checks.map((check) =>
    validationReason(
      'SAFETY_BREACHED',
      SUBJECT,
      `${check.boundary} observed ${check.observed ?? 'no value'} against limit ${check.declared_limit}; expected within_limits`,
    ),
  );
  if (perCheck.length > 0 || assessment.safety_status !== 'breached') {
    return perCheck;
  }
  return [validationReason('SAFETY_BREACHED', SUBJECT, 'safety_status is breached; expected within_limits')];
}

function otherUncertainty(
  checks: readonly SafetyCheck[],
  pending: readonly SafetyCheck[],
): readonly ValidationReason[] {
  const otherPending = pending
    .filter((check) => check.boundary !== 'BILLED_COST')
    .map((check) => `${check.boundary} is unverified`);
  const noBillingPending = pending.length === 0 ? ['safety_status is unverified with no unverified check'] : [];
  const unsafeguarded = REAL_TIME_SAFEGUARDS.filter(
    (boundary) => !checks.some((check) => check.boundary === boundary && check.result === 'within_limits'),
  ).map((boundary) => `${boundary} is not recorded within limits`);
  return [...noBillingPending, ...otherPending, ...unsafeguarded].map((problem) =>
    validationReason(
      'SAFETY_UNVERIFIED',
      SUBJECT,
      `${problem}; expected only a billed-cost check pending with ${REAL_TIME_SAFEGUARDS.join(', ')} within limits (OR-RUA-005)`,
    ),
  );
}

function unverified(reasons: readonly ValidationReason[]): SafetyStanding {
  return { standing: 'unverified', reasons };
}
