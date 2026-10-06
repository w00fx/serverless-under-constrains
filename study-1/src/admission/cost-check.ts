// Admission step A14 (SAFETY, boundary ESTIMATED_COST; BR-RUA-046, OR-RUA-003..005, D-19, D-27):
// the conservative attributable-usage estimate of the planned resources over the active window,
// priced at the recorded ceilings, must not exceed the execution kind's ceiling. The study never
// enables provisioned concurrency (addendum §4), so the plan has no provisioned-concurrency line.

import type { ExecutionKind, VariantId } from '../record-contract/primitives.ts';
import type { ConservativeEstimates } from '../record-contract/records/group-a/execution_manifest.ts';
import { estimateAttributableCost, estimateWithinCeiling } from '../safety/cost-estimate.ts';
import type { PriceCeilingTable } from '../safety/price-ceilings.ts';
import { planExecutionResources } from '../safety/resource-plan.ts';
import type { SafetyLimits } from '../safety/safety-limits.ts';
import { admissionReason } from './admission-reason.ts';
import { failed, failedWithAll, passed } from './preflight-check.ts';
import type { CheckStatement, StepVerdict } from './preflight-check.ts';

export interface CostCheckInput {
  readonly kind: ExecutionKind;
  readonly variant_id?: VariantId;
  readonly limits: SafetyLimits;
  readonly treatment_poll_interval_ms: number;
  readonly prices: PriceCeilingTable;
}

/**
 * Step A14: plan, price and compare with the ceiling.
 *
 * @example
 * const verdict = assessEstimatedCost({ kind: 'RUN', limits: RUN_SAFETY, treatment_poll_interval_ms: 250, prices: PRICE_CEILINGS });
 * if (verdict.passed) verdict.value.estimated_cost_usd; // '0.28'
 */
export function assessEstimatedCost(input: CostCheckInput): StepVerdict<ConservativeEstimates> {
  const plan = planExecutionResources({
    kind: input.kind,
    ...(input.variant_id === undefined ? {} : { variant_id: input.variant_id }),
    active_ms: input.limits.active_ms,
    treatment_poll_interval_ms: input.treatment_poll_interval_ms,
  });
  const statement: CheckStatement = {
    subject: 'estimated_cost',
    expected: { boundary: 'ESTIMATED_COST', ceiling_usd: input.limits.ceiling_usd },
  };
  const estimate = estimateAttributableCost(plan, input.prices);
  if (!estimate.ok) {
    return failedWithAll(
      'SAFETY',
      statement,
      estimate.error,
      admissionReason('COST_NOT_ESTIMATED', 'BR-RUA-046', 'the cost could not be estimated; expected an estimate'),
    );
  }
  const { estimated_cost_usd: estimated, resource_counts: counts } = estimate.value;
  const observed: CheckStatement = { ...statement, observed: { estimated_cost_usd: estimated } };
  if (!estimateWithinCeiling(estimated, input.limits.ceiling_usd)) {
    return failed('SAFETY', observed, [
      admissionReason(
        'ESTIMATED_COST_ABOVE_CEILING',
        'BR-RUA-046',
        `the estimated attributable cost is USD ${estimated}; expected at most the ceiling USD ${input.limits.ceiling_usd}`,
      ),
    ]);
  }
  return passed({ estimated_cost_usd: estimated, resource_counts: counts }, observed);
}
