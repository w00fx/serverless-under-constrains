// The reasons an `unverified` billed-cost check records (BR-RUA-047; schema `billing_import`). An
// export can hold any number of lines, so reasons are aggregated: one reason per code, naming how
// many lines it covers and the first few of them with their cause (A-12: findings must not scale
// with input). Reasons follow the catalogue order of `BILLING_UNVERIFIED_CODES`.

import { boundedJsonText } from '../record-contract/json-value.ts';
import type { BillingUnverifiedReason } from '../record-contract/records/group-c/billing_import.ts';
import { BILLING_UNVERIFIED_CODES } from '../record-contract/records/group-c/vocabulary.ts';
import type { BillingUnverifiedCode } from '../record-contract/records/group-c/vocabulary.ts';

/** A line the import could not attribute, and why. */
export interface UnattributableLine {
  readonly line_id: string;
  readonly code: BillingUnverifiedCode;
  readonly cause: string;
}

/** How many example lines one aggregated reason names. */
export const REASON_SAMPLE_LIMIT = 5;

const EXPECTATIONS: Readonly<Record<BillingUnverifiedCode, string>> = {
  INCOMPLETE_ATTRIBUTION:
    'expected exact account, resource-manifest identity, suc:run_id tag, run-owned operation, contained interval, currency and cost',
  NON_USD_LINE: 'expected every attributable line in USD; no exchange-rate conversion is made',
  MIXED_CURRENCY: 'expected one currency across attributable lines; no conversion is made',
  INCOMPLETE_PERIOD: 'expected a final billing period that contains the attribution window',
  SHARED_OR_UNOWNED_CHARGE: 'expected only run-owned usage; no proportional allocation is made',
};

/**
 * Aggregates unattributable lines into at most one reason per code, in catalogue order.
 *
 * @example
 * unverifiedReasons([{ line_id: 'row:4', code: 'INCOMPLETE_ATTRIBUTION', cause: 'blank resource id' }]);
 * // [{ code: 'INCOMPLETE_ATTRIBUTION', subject: 'BR-RUA-047', detail: '1 line(s): row:4 (blank resource id); expected …' }]
 */
export function unverifiedReasons(lines: readonly UnattributableLine[]): readonly BillingUnverifiedReason[] {
  return BILLING_UNVERIFIED_CODES.flatMap((code) => {
    const matching = lines.filter((line) => line.code === code);
    return matching.length === 0 ? [] : [aggregatedReason(code, matching)];
  });
}

/**
 * Orders reasons from several sources by the catalogue order of their codes.
 *
 * @example
 * sortUnverifiedReasons([periodReason, attributionReason]); // INCOMPLETE_ATTRIBUTION before INCOMPLETE_PERIOD
 */
export function sortUnverifiedReasons(reasons: readonly BillingUnverifiedReason[]): readonly BillingUnverifiedReason[] {
  return [...reasons].sort(
    (a, b) => BILLING_UNVERIFIED_CODES.indexOf(a.code) - BILLING_UNVERIFIED_CODES.indexOf(b.code),
  );
}

/**
 * Builds one reason that states its problem and the expected shape of its code.
 *
 * @example
 * unverifiedReason('INCOMPLETE_PERIOD', 'the billing period is not final');
 */
export function unverifiedReason(code: BillingUnverifiedCode, problem: string): BillingUnverifiedReason {
  return { code, subject: 'BR-RUA-047', detail: `${problem}; ${EXPECTATIONS[code]}` };
}

/**
 * Quotes one untrusted export cell for a detail text, bounded by the kernel quote limit (A-05 policy 1).
 *
 * @example
 * quoteCell('Tax'); // '"Tax"'
 */
export function quoteCell(cell: string): string {
  return boundedJsonText(cell);
}

/**
 * Names the first `REASON_SAMPLE_LIMIT` items and counts the rest, so a detail never grows with the
 * export (A-12).
 *
 * @example
 * sampledList(['BRL', 'EUR', 'USD'], (code) => code); // 'BRL, EUR, USD'
 * sampledList(sevenLines, (line) => line.line_id); // 'row:1, row:2, row:3, row:4, row:5, and 2 more'
 */
export function sampledList<T>(items: readonly T[], describe: (item: T) => string): string {
  const listed = items.slice(0, REASON_SAMPLE_LIMIT).map(describe).join(', ');
  const unlisted = items.length - REASON_SAMPLE_LIMIT;
  return unlisted > 0 ? `${listed}, and ${String(unlisted)} more` : listed;
}

function aggregatedReason(code: BillingUnverifiedCode, lines: readonly UnattributableLine[]): BillingUnverifiedReason {
  const samples = sampledList(lines, (line) => `${line.line_id} (${line.cause})`);
  return unverifiedReason(code, `${String(lines.length)} line(s): ${samples}`);
}
