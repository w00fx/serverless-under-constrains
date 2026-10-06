// The six treatment conditions BR-RUA-010..015, shared by trial fidelity and the probe verdict
// (design §8.10). They are evaluated in their fixed order, which `condition_results` keeps.

import type { SixConditionResults } from '../record-contract/records/group-c/shared-shapes.ts';
import { evaluateApplicationTimeout } from './application-timeout.ts';
import { evaluateCausalJoin } from './causal-join.ts';
import { evaluateCommitBeforeTimer } from './commit-before-timer.ts';
import { evaluateContinuedExecution } from './continued-execution.ts';
import { evaluateControlledRelease } from './controlled-release.ts';
import { evaluateNoCallerSuccess } from './no-caller-success.ts';
import type { TreatmentView } from './treatment-view.ts';

/**
 * Evaluates BR-RUA-010 to BR-RUA-015, in that order.
 *
 * @example
 * evaluateTreatmentConditions(view).map((condition) => condition.result); // six results
 */
export function evaluateTreatmentConditions(view: TreatmentView): SixConditionResults {
  return [
    evaluateCommitBeforeTimer(view),
    evaluateApplicationTimeout(view),
    evaluateContinuedExecution(view),
    evaluateCausalJoin(view),
    evaluateControlledRelease(view),
    evaluateNoCallerSuccess(view),
  ];
}
