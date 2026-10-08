// The admission cost estimate (BR-RUA-046, design §5.3 `estimateAttributableCost`, §10.1 A14,
// D-19): the planned usage priced at the committed ceilings, summed exactly and rounded up to
// whole cents, then compared with the execution kind's ceiling. An estimate within the ceiling is
// an admission boundary, never a billing guarantee; the billed cost is checked later from the
// billing export (BR-RUA-047).

import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { MoneyDecimal, Result, StructuredReason } from '../record-contract/primitives.ts';
import type { PriceCeilingTable, PriceMeter } from './price-ceilings.ts';
import type { ResourcePlan } from './resource-plan.ts';
import { centsCeiling, exactUsd, scaledUsd } from './usd-amount.ts';

const SUBJECT = 'BR-RUA-046';

export interface CostLine {
  readonly meter: PriceMeter;
  readonly quantity: number;
  readonly usd_per_unit: MoneyDecimal;
  /** Exact `quantity × usd_per_unit`. */
  readonly cost_usd: MoneyDecimal;
}

export interface CostEstimate {
  /** The exact sum rounded up to whole cents. */
  readonly estimated_cost_usd: MoneyDecimal;
  readonly lines: readonly CostLine[];
  readonly resource_counts: Readonly<Record<string, number>>;
}

/**
 * Prices a resource plan. Every planned meter needs exactly one ceiling with a readable price,
 * and every quantity must be a nonnegative safe integer; otherwise the estimate is refused with
 * one reason per problem.
 *
 * @example
 * const estimate = estimateAttributableCost(planExecutionResources(input), PRICE_CEILINGS);
 * if (estimate.ok) estimate.value.estimated_cost_usd; // '0.28'
 */
export function estimateAttributableCost(
  plan: ResourcePlan,
  prices: PriceCeilingTable,
): Result<CostEstimate, readonly StructuredReason[]> {
  const lines: CostLine[] = [];
  const reasons: StructuredReason[] = [];
  let total = 0n;
  for (const usage of plan.usage) {
    const priced = priceLine(usage.meter, usage.quantity, prices);
    if (!priced.ok) {
      reasons.push(priced.error);
      continue;
    }
    total += priced.value.scaled;
    lines.push(priced.value.line);
  }
  if (reasons.length > 0) {
    return err(reasons);
  }
  return ok({ estimated_cost_usd: centsCeiling(total), lines, resource_counts: plan.resource_counts });
}

/**
 * True when the estimate is at or below the ceiling; an unreadable ceiling is never satisfied.
 *
 * @example
 * estimateWithinCeiling('0.28' as MoneyDecimal, '5.00' as MoneyDecimal); // true
 */
export function estimateWithinCeiling(estimate: MoneyDecimal, ceiling: MoneyDecimal): boolean {
  const limit = scaledUsd(ceiling);
  const value = scaledUsd(estimate);
  return limit !== undefined && value !== undefined && value <= limit;
}

interface PricedLine {
  readonly line: CostLine;
  readonly scaled: bigint;
}

function priceLine(
  meter: PriceMeter,
  quantity: number,
  prices: PriceCeilingTable,
): Result<PricedLine, StructuredReason> {
  const matching = prices.filter((price) => price.meter === meter);
  const [price] = matching;
  if (price === undefined || matching.length > 1) {
    return err(
      costReason(
        'PRICE_CEILING_MISSING',
        `meter ${meter} has ${String(matching.length)} price ceilings; expected exactly one committed ceiling`,
      ),
    );
  }
  const unitPrice = scaledUsd(price.usd_per_unit);
  if (unitPrice === undefined) {
    return err(
      costReason(
        'PRICE_CEILING_INVALID',
        `meter ${meter} is priced ${boundedJsonText(price.usd_per_unit)}; expected a nonnegative decimal with at most 12 fraction digits`,
      ),
    );
  }
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    return err(
      costReason(
        'PLANNED_QUANTITY_INVALID',
        `meter ${meter} plans ${String(quantity)}; expected a nonnegative safe integer`,
      ),
    );
  }
  const scaled = unitPrice * BigInt(quantity);
  return ok({ line: { meter, quantity, usd_per_unit: price.usd_per_unit, cost_usd: exactUsd(scaled) }, scaled });
}

function costReason(code: string, detail: string): StructuredReason {
  return { code, subject: SUBJECT, detail };
}
