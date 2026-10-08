// Exact billing-line correlation (BR-RUA-047, design §8.17, AC-RUA-024/034). Each export line ends
// in exactly one of three places, decided in this order:
//
// 1. excluded and listed: tax, credit, refund, discount, fee and Savings Plan fee and negation lines;
//    lines of another account; lines whose usage interval does not touch the attribution window;
//    usage that carries no run identity at all (`NOT_RUN_OWNED`);
// 2. attributed: a `Usage` line in the frozen account whose resource id is a resource-manifest
//    identity, whose activated `suc:run_id` tag equals the execution id, whose product and operation
//    are run-owned, whose usage interval lies inside the window and whose currency and cost read
//    exactly;
// 3. unattributable, which makes the check `unverified`: a candidate that is neither (a blank
//    resource id or usage account, half of the identity, an interval that straddles the window, an
//    unreadable cell: `INCOMPLETE_ATTRIBUTION`; a run-owned resource charged for a service or
//    operation outside the allowlist, run usage covered by a shared Savings Plan or Reserved
//    Instance commitment, or a line type this import cannot classify: `SHARED_OR_UNOWNED_CHARGE`).
//
// Commitment-covered usage (`SavingsPlanCoveredUsage`, `DiscountedUsage`) is run-owned compute
// usage that BR-RUA-047 keeps inside the safety boundary, but its cost is a share of a commitment
// bought for the whole account: excluding it would drop run usage from the total and could report
// `within_limit` falsely, and pricing it would be the proportional allocation the PoC forbids. So
// it is `unverified` when it may be the run's, and excluded when it carries no run identity
// (evidence/WP-18/decisions.md, single-pass review).
//
// Nothing is ever split, allocated or converted. Currency judgement is the billed-cost check's.

import type { MoneyDecimal } from '../record-contract/primitives.ts';
import type {
  AttributedBillingLine,
  BillingUnverifiedReason,
  ExcludedBillingLine,
} from '../record-contract/records/group-c/billing_import.ts';
import type { BillingExclusionCode, BillingUnverifiedCode } from '../record-contract/records/group-c/vocabulary.ts';
import type { AttributionContext } from './attribution-context.ts';
import type { CurLine } from './cur-export.ts';
import { parseCurCost } from './money-decimal.ts';
import { quoteCell, unverifiedReasons } from './unverified-reasons.ts';
import type { UnattributableLine } from './unverified-reasons.ts';
import { isContained, isDisjoint, parseCurInterval } from './usage-window.ts';
import type { UsageInterval } from './usage-window.ts';

/** The correlation of one export with one execution. */
export interface AttributionResult {
  readonly window: UsageInterval;
  readonly lines_used: readonly AttributedBillingLine[];
  readonly exclusions: readonly ExcludedBillingLine[];
  /** One aggregated reason per code; empty when every candidate line was attributed. */
  readonly reasons: readonly BillingUnverifiedReason[];
}

type LineDisposition =
  | { readonly kind: 'attributed'; readonly line: AttributedBillingLine }
  | { readonly kind: 'excluded'; readonly line: ExcludedBillingLine }
  | { readonly kind: 'unattributable'; readonly line: UnattributableLine };

/** CUR `line_item_line_item_type` values BR-RUA-047 excludes, with the exclusion each one records. */
export const EXCLUDED_LINE_TYPES: ReadonlyMap<string, BillingExclusionCode> = new Map([
  ['Tax', 'TAX'],
  ['Credit', 'CREDIT'],
  ['Refund', 'REFUND'],
  ['Discount', 'DISCOUNT'],
  ['BundledDiscount', 'DISCOUNT'],
  ['Fee', 'FEE'],
  ['RIFee', 'FEE'],
  ['SavingsPlanUpfrontFee', 'SAVINGS_PLAN'],
  ['SavingsPlanRecurringFee', 'SAVINGS_PLAN'],
  ['SavingsPlanNegation', 'SAVINGS_PLAN'],
]);

/** CUR line types of usage a shared commitment pays for: Savings Plans and Reserved Instances. */
export const COMMITMENT_COVERED_LINE_TYPES: ReadonlySet<string> = new Set([
  'SavingsPlanCoveredUsage',
  'DiscountedUsage',
]);

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Correlates export lines with one execution by exact identity only, and states what it could not
 * attribute.
 *
 * @example
 * const attribution = correlateBillingLines(lines, context);
 * attribution.lines_used; // the exactly attributed usage lines, costs as exported
 */
export function correlateBillingLines(lines: readonly CurLine[], ctx: AttributionContext): AttributionResult {
  const dispositions = lines.map((line) => classifyLine(line, ctx));
  return {
    window: ctx.window,
    lines_used: dispositions.flatMap((d) => (d.kind === 'attributed' ? [d.line] : [])),
    exclusions: dispositions.flatMap((d) => (d.kind === 'excluded' ? [d.line] : [])),
    reasons: unverifiedReasons(dispositions.flatMap((d) => (d.kind === 'unattributable' ? [d.line] : []))),
  };
}

function classifyLine(line: CurLine, ctx: AttributionContext): LineDisposition {
  const excludedType = EXCLUDED_LINE_TYPES.get(line.line_item_type);
  if (excludedType !== undefined) {
    return excluded(line, excludedType, `line type ${quoteCell(line.line_item_type)} is not attributable usage`);
  }
  const accountBlank = isBlank(line.usage_account_id);
  if (!accountBlank && line.usage_account_id !== ctx.account_id) {
    return excluded(
      line,
      'OTHER_ACCOUNT',
      `usage account ${quoteCell(line.usage_account_id)} is not ${ctx.account_id}`,
    );
  }
  const interval = parseCurInterval(line.usage_start, line.usage_end);
  if (interval !== undefined && isDisjoint(interval, ctx.window)) {
    return excluded(line, 'OUTSIDE_USAGE_WINDOW', `usage ${interval.start} to ${interval.end} is outside the window`);
  }
  // A blank account is a missing identity, never proof of another account (BR-RUA-047).
  return accountBlank ? classifyMissingAccount(line, ctx) : classifyByLineType(line, ctx, interval);
}

function classifyByLineType(
  line: CurLine,
  ctx: AttributionContext,
  interval: UsageInterval | undefined,
): LineDisposition {
  if (line.line_item_type === 'Usage') {
    return classifyUsage(line, ctx, interval);
  }
  if (!COMMITMENT_COVERED_LINE_TYPES.has(line.line_item_type)) {
    return unattributable(
      line,
      'SHARED_OR_UNOWNED_CHARGE',
      `line type ${quoteCell(line.line_item_type)} cannot be assigned`,
    );
  }
  return mayBeRunUsage(line, ctx)
    ? unattributable(
        line,
        'SHARED_OR_UNOWNED_CHARGE',
        `line type ${quoteCell(line.line_item_type)} is usage covered by a shared commitment`,
      )
    : excluded(line, 'NOT_RUN_OWNED', `${quoteCell(line.line_item_type)} line carries no run identity`);
}

function classifyMissingAccount(line: CurLine, ctx: AttributionContext): LineDisposition {
  return mayBeRunUsage(line, ctx)
    ? unattributable(line, 'INCOMPLETE_ATTRIBUTION', 'blank usage account')
    : excluded(line, 'NOT_RUN_OWNED', 'blank usage account and no run identity');
}

function classifyUsage(line: CurLine, ctx: AttributionContext, interval: UsageInterval | undefined): LineDisposition {
  const tagged = line.run_tag === ctx.ownership_tag_value;
  if (isBlank(line.resource_id)) {
    return mayBeRunUsage(line, ctx)
      ? unattributable(line, 'INCOMPLETE_ATTRIBUTION', 'blank resource id')
      : excluded(line, 'NOT_RUN_OWNED', 'blank resource id, no run tag and no run-owned operation');
  }
  const owned = ctx.resource_identities.has(line.resource_id);
  if (!owned && !tagged) {
    return excluded(line, 'NOT_RUN_OWNED', `resource ${quoteCell(line.resource_id)} carries no run identity`);
  }
  if (!owned || !tagged) {
    const missing = owned ? 'no matching suc:run_id tag' : 'resource not in the resource manifest';
    return unattributable(line, 'INCOMPLETE_ATTRIBUTION', missing);
  }
  if (!isAllowlisted(line, ctx)) {
    const charge = `${quoteCell(line.product_code)}/${quoteCell(line.operation)}`;
    return unattributable(line, 'SHARED_OR_UNOWNED_CHARGE', `${charge} is not a run-owned operation`);
  }
  return attributedUsage(line, ctx, interval);
}

function attributedUsage(line: CurLine, ctx: AttributionContext, interval: UsageInterval | undefined): LineDisposition {
  if (interval === undefined) {
    return unattributable(line, 'INCOMPLETE_ATTRIBUTION', 'unreadable usage interval');
  }
  if (!isContained(interval, ctx.window)) {
    return unattributable(line, 'INCOMPLETE_ATTRIBUTION', 'usage interval straddles the window');
  }
  const cost = parseCurCost(line.cost);
  if (cost === undefined || !CURRENCY_PATTERN.test(line.currency)) {
    return unattributable(
      line,
      'INCOMPLETE_ATTRIBUTION',
      `unreadable cost ${quoteCell(line.cost)} ${quoteCell(line.currency)}`,
    );
  }
  return { kind: 'attributed', line: attributedLine(line, interval, cost) };
}

function attributedLine(line: CurLine, interval: UsageInterval, cost: MoneyDecimal): AttributedBillingLine {
  return {
    line_id: line.line_id,
    product_code: line.product_code,
    operation: line.operation,
    resource_id: line.resource_id,
    usage_start: interval.start,
    usage_end: interval.end,
    currency: line.currency,
    cost,
  };
}

// Whether the line may be the run's: it names a run resource or carries the run tag, or its
// resource id is blank (normal for API requests) on a run-owned operation.
function mayBeRunUsage(line: CurLine, ctx: AttributionContext): boolean {
  if (line.run_tag === ctx.ownership_tag_value || ctx.resource_identities.has(line.resource_id)) {
    return true;
  }
  return isBlank(line.resource_id) && isAllowlisted(line, ctx);
}

function isAllowlisted(line: CurLine, ctx: AttributionContext): boolean {
  return ctx.charge_allowlist.get(line.product_code)?.has(line.operation) === true;
}

function isBlank(cell: string): boolean {
  return cell.trim() === '';
}

function excluded(line: CurLine, exclusion: BillingExclusionCode, detail: string): LineDisposition {
  return { kind: 'excluded', line: { line_id: line.line_id, exclusion, detail } };
}

function unattributable(line: CurLine, code: BillingUnverifiedCode, cause: string): LineDisposition {
  return { kind: 'unattributable', line: { line_id: line.line_id, code, cause } };
}
