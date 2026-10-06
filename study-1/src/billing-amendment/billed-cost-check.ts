// The billed-cost check of BR-RUA-047 (`within_limit | breached | unverified`, design §5.3
// `deriveBilledCostCheck`). It is `unverified` whenever attribution is incomplete, the billing period
// is not final or does not cover the attribution window, any attributable line is not USD, or the
// attributable lines mix currencies. Otherwise the exact USD sum is compared with the declared
// ceiling: at or below it is `within_limit` (the ceiling is a maximum, OR-RUA-003..005), above it is
// `breached`. No exchange-rate conversion and no proportional allocation ever happen.

import type { MoneyDecimal } from '../record-contract/primitives.ts';
import type { BilledCostOutcome, BillingUnverifiedReason } from '../record-contract/records/group-c/billing_import.ts';
import type { ExportBillingPeriod } from './cur-export.ts';
import type { AttributionResult } from './line-attribution.ts';
import { compareMoney, sumMoney } from './money-decimal.ts';
import {
  quoteCell,
  sampledList,
  sortUnverifiedReasons,
  unverifiedReason,
  unverifiedReasons,
} from './unverified-reasons.ts';
import { isContained } from './usage-window.ts';
import type { UsageInterval } from './usage-window.ts';

/** The billed-cost outcome as the `billing_import` record states it. */
export type BilledCostAssessment = BilledCostOutcome;

/**
 * Derives the billed-cost check from an attribution and the execution's declared USD ceiling.
 *
 * @example
 * deriveBilledCostCheck(attribution, '5.00' as MoneyDecimal);
 * // { billed_cost_check: 'within_limit', attributed_total_usd: '1.2500002', reasons: [] }
 */
export function deriveBilledCostCheck(a: AttributionResult, ceiling: MoneyDecimal): BilledCostAssessment {
  const [first, ...rest] = sortUnverifiedReasons([...a.reasons, ...currencyReasons(a)]);
  if (first !== undefined) {
    return { billed_cost_check: 'unverified', reasons: [first, ...rest] };
  }
  const total = sumMoney(a.lines_used.map((line) => line.cost));
  return {
    billed_cost_check: compareMoney(total, ceiling) <= 0 ? 'within_limit' : 'breached',
    attributed_total_usd: total,
    reasons: [],
  };
}

/**
 * The `INCOMPLETE_PERIOD` reason, when the export's billing period is not final or does not contain
 * the attribution window; empty otherwise.
 *
 * @example
 * periodReasons({ period_start, period_end, period_final: false }, window); // [{ code: 'INCOMPLETE_PERIOD', … }]
 */
export function periodReasons(period: ExportBillingPeriod, window: UsageInterval): readonly BillingUnverifiedReason[] {
  const range = `${period.period_start} to ${period.period_end}`;
  const problems = [
    ...(period.period_final ? [] : [`billing period ${range} is not final (blank bill_invoice_id)`]),
    ...(isContained(window, { start: period.period_start, end: period.period_end })
      ? []
      : [`attribution window ${window.start} to ${window.end} is not inside billing period ${range}`]),
  ];
  return problems.length === 0 ? [] : [unverifiedReason('INCOMPLETE_PERIOD', problems.join('; '))];
}

function currencyReasons(a: AttributionResult): readonly BillingUnverifiedReason[] {
  const nonUsd = a.lines_used
    .filter((line) => line.currency !== 'USD')
    .map((line) => ({
      line_id: line.line_id,
      code: 'NON_USD_LINE' as const,
      cause: `currency ${quoteCell(line.currency)}`,
    }));
  const currencies = [...new Set(a.lines_used.map((line) => line.currency))].sort();
  // Each code is three letters, but an export can name thousands of them (A-12).
  const mixed =
    currencies.length > 1
      ? [unverifiedReason('MIXED_CURRENCY', `attributable lines use ${sampledList(currencies, (code) => code)}`)]
      : [];
  return [...unverifiedReasons(nonUsd), ...mixed];
}
