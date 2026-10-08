// The probe verdict, exact BR-RUA-027 precedence (design §8.11):
//   invalid probe                                        -> indeterminate
//   else an unaffected condition conclusively fails      -> fail (the transport is rejected)
//   else every condition passes and evidence is verified -> pass
//   else                                                 -> indeterminate (only a new probe may follow)

import type { GateValue } from '../../record-contract/primitives.ts';
import type { ConditionResult } from '../../record-contract/records/group-c/shared-shapes.ts';
import type { PreservationVerdict, TrialValidity } from '../../record-contract/records/group-c/vocabulary.ts';

/**
 * Derives the transport-probe verdict.
 *
 * @example
 * deriveProbeVerdict('valid', sixPassingConditions, 'verified'); // 'pass'
 * deriveProbeVerdict('invalid', sixPassingConditions, 'verified'); // 'indeterminate'
 */
export function deriveProbeVerdict(
  validity: TrialValidity,
  conditions: readonly ConditionResult[],
  integrity: GateValue,
): PreservationVerdict {
  if (validity === 'invalid') {
    return 'indeterminate';
  }
  if (conditions.some((condition) => condition.result === 'fail' && condition.affected_by.length === 0)) {
    return 'fail';
  }
  if (conditions.every((condition) => condition.result === 'pass') && integrity === 'verified') {
    return 'pass';
  }
  return 'indeterminate';
}
