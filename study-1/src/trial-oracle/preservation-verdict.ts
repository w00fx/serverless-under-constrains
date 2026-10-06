// BR-RUA-006 preservation verdict and BR-RUA-030 correct completion, exactly as design §8.6 and
// §8.8 state them. Only the five business rules decide a valid trial's verdict; a not-applicable
// rule is ignored. `correct_completion` follows the verdict, and a pass completes correctly only
// with a successful terminal reason (AC-RUA-052).

import type { PreservationVerdict, TrialValidity } from '../record-contract/records/group-c/vocabulary.ts';
import type { ProcessingTerminalReason } from '../record-contract/records/group-b/vocabulary.ts';
import type { RuleOutcome } from '../record-contract/primitives.ts';
import type { OracleRuleId } from '../record-contract/records/group-c/vocabulary.ts';
import { isVerdictBusinessRule } from './oracle-vocabulary.ts';

/** The members of a rule result the verdict reads. */
export interface RuleOutcomeEntry {
  readonly rule_id: OracleRuleId;
  readonly result: RuleOutcome;
}

/**
 * The preservation verdict of a trial from its validity and rule results.
 *
 * @example
 * derivePreservationVerdict('valid', [{ rule_id: 'BR-RUA-001', result: 'fail' }]); // 'fail'
 * derivePreservationVerdict('indeterminate', [{ rule_id: 'BR-RUA-001', result: 'fail' }]); // 'indeterminate'
 */
export function derivePreservationVerdict(
  validity: TrialValidity,
  rules: readonly RuleOutcomeEntry[],
): PreservationVerdict {
  if (validity !== 'valid') {
    return 'indeterminate';
  }
  const business = rules.filter((rule) => isVerdictBusinessRule(rule.rule_id) && rule.result !== 'not_applicable');
  if (business.some((rule) => rule.result === 'fail')) {
    return 'fail';
  }
  if (business.some((rule) => rule.result === 'indeterminate')) {
    return 'indeterminate';
  }
  return 'pass';
}

/**
 * BR-RUA-030 `correct_completion`. A pass without a terminal reason cannot come out of
 * `evaluateTrial` (a valid trial has a verified G6, which needs a terminal reason; D-17), but the
 * function stays total.
 *
 * @example
 * deriveCorrectCompletion('pass', 'RETRIES_EXHAUSTED'); // false (AC-RUA-052)
 * deriveCorrectCompletion('indeterminate', 'SUCCEEDED'); // null
 */
export function deriveCorrectCompletion(
  verdict: PreservationVerdict,
  terminal: ProcessingTerminalReason | null,
): boolean | null {
  if (verdict === 'indeterminate') {
    return null;
  }
  if (verdict === 'fail') {
    return false;
  }
  if (terminal === null) {
    return null;
  }
  return terminal === 'SUCCEEDED';
}
