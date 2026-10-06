// The CUR 2.0 columns the billing import reads (BR-RUA-047; research aws-semantics §8; UNVERIFIED
// U-10) and their projection into lines and a billing period. Correlation needs every line column;
// an export without one of them cannot attribute anything, which makes the check `unverified`
// (`INCOMPLETE_ATTRIBUTION`, "incomplete exports produce unverified"). The billing period is what the
// amendment states about its export, so an export whose period cannot be read is refused instead.
//
// The activated ownership tag is read from one plain column, `resource_tag_suc_run_id`: the Data
// Exports query selects the `suc:run_id` attribute of the `resource_tags` map under that alias, so no
// map-key spelling is guessed here (evidence/WP-18/decisions.md).

import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { BillingUnverifiedReason } from '../record-contract/records/group-c/billing_import.ts';
import type { CurTable } from './cur-csv.ts';
import { parseCurTimestamp } from './usage-window.ts';

/** Line columns, keyed by the `CurLine` field each one fills. */
export const CUR_LINE_COLUMNS = {
  usage_account_id: 'line_item_usage_account_id',
  line_item_type: 'line_item_line_item_type',
  resource_id: 'line_item_resource_id',
  product_code: 'line_item_product_code',
  operation: 'line_item_operation',
  usage_start: 'line_item_usage_start_date',
  usage_end: 'line_item_usage_end_date',
  currency: 'line_item_currency_code',
  cost: 'line_item_unblended_cost',
  run_tag: 'resource_tag_suc_run_id',
} as const;

/** Billing-period columns; `bill_invoice_id` stays blank until the period's report is final. */
export const CUR_PERIOD_COLUMNS = {
  start: 'bill_billing_period_start_date',
  end: 'bill_billing_period_end_date',
  invoice: 'bill_invoice_id',
} as const;

type CurLineField = keyof typeof CUR_LINE_COLUMNS;

/** One export record as exact cell text, plus its stable id `row:<n>` (n counts data records from 1). */
export type CurLine = { readonly line_id: string } & Readonly<Record<CurLineField, string>>;

/** The billing period the export covers. */
export interface ExportBillingPeriod {
  readonly period_start: UtcMillis;
  readonly period_end: UtcMillis;
  /** True only when every record carries an invoice id (CUR leaves it blank until final). */
  readonly period_final: boolean;
}

const LINE_FIELDS = Object.keys(CUR_LINE_COLUMNS) as CurLineField[];

/**
 * Projects every data record onto the line columns, or reports the missing columns as the
 * `INCOMPLETE_ATTRIBUTION` reason that makes the billed-cost check `unverified`.
 *
 * @example
 * const lines = readCurLines(table);
 * if (lines.ok) attribution = correlateBillingLines(lines.value, context);
 */
export function readCurLines(table: CurTable): Result<readonly CurLine[], BillingUnverifiedReason> {
  const indexes = columnIndexes(table.columns);
  const positions = LINE_FIELDS.flatMap((field) => {
    const at = indexes.get(CUR_LINE_COLUMNS[field]);
    return at === undefined ? [] : [[field, at] as const];
  });
  if (positions.length < LINE_FIELDS.length) {
    const missing = Object.values(CUR_LINE_COLUMNS).filter((column) => !indexes.has(column));
    return err({
      code: 'INCOMPLETE_ATTRIBUTION',
      subject: 'BR-RUA-047',
      detail: `the export lacks column(s) ${missing.join(', ')}; expected every line column of ${Object.values(CUR_LINE_COLUMNS).join(', ')}`,
    });
  }
  return ok(table.rows.map((row, index) => lineOf(row, index, positions)));
}

/**
 * Reads the single billing period every record of the export names, or why it cannot be read: a
 * missing period column, no record, records naming different periods, or an unreadable instant.
 *
 * @example
 * readExportPeriod(table); // { ok: true, value: { period_start: '2026-10-01T00:00:00.000Z', …, period_final: false } }
 */
export function readExportPeriod(table: CurTable): Result<ExportBillingPeriod, StructuredReason> {
  const indexes = columnIndexes(table.columns);
  const startIndex = indexes.get(CUR_PERIOD_COLUMNS.start);
  const endIndex = indexes.get(CUR_PERIOD_COLUMNS.end);
  if (startIndex === undefined || endIndex === undefined) {
    return err(periodReason(`the export lacks ${CUR_PERIOD_COLUMNS.start} or ${CUR_PERIOD_COLUMNS.end}`));
  }
  const starts = new Set(table.rows.map((row) => cellAt(row, startIndex)));
  const ends = new Set(table.rows.map((row) => cellAt(row, endIndex)));
  if (starts.size !== 1 || ends.size !== 1) {
    return err(periodReason(`the export names ${String(starts.size)} period start(s) and ${String(ends.size)} end(s)`));
  }
  // Each set holds exactly one text here.
  return periodOf([...starts].join(''), [...ends].join(''), isFinal(table, indexes.get(CUR_PERIOD_COLUMNS.invoice)));
}

function periodOf(startText: string, endText: string, final: boolean): Result<ExportBillingPeriod, StructuredReason> {
  const start = parseCurTimestamp(startText);
  const end = parseCurTimestamp(endText);
  if (start === undefined || end === undefined || Date.parse(end) <= Date.parse(start)) {
    return err(periodReason(`the period ${boundedJsonText(startText)} to ${boundedJsonText(endText)} is unreadable`));
  }
  return ok({ period_start: start, period_end: end, period_final: final });
}

function isFinal(table: CurTable, invoiceIndex: number | undefined): boolean {
  if (invoiceIndex === undefined) {
    return false;
  }
  return table.rows.every((row) => cellAt(row, invoiceIndex).trim() !== '');
}

function lineOf(
  row: readonly string[],
  index: number,
  positions: readonly (readonly [CurLineField, number])[],
): CurLine {
  const cells = positions.map(([field, at]) => [field, cellAt(row, at)] as const);
  return { line_id: `row:${String(index + 1)}`, ...(Object.fromEntries(cells) as Record<CurLineField, string>) };
}

// A Map, never an object: a column may be named `__proto__` or `constructor` (A-05).
function columnIndexes(columns: readonly string[]): ReadonlyMap<string, number> {
  return new Map(columns.map((column, index) => [column, index]));
}

// The parser guarantees one field per header column; slicing reads that field without a fallback
// branch no table can reach.
function cellAt(row: readonly string[], index: number): string {
  return row.slice(index, index + 1).join('');
}

function periodReason(problem: string): StructuredReason {
  return {
    code: 'CUR_EXPORT_PERIOD_UNREADABLE',
    subject: 'BR-RUA-047',
    detail: `${problem}; expected every record to name one billing period as ${CUR_PERIOD_COLUMNS.start} < ${CUR_PERIOD_COLUMNS.end} (YYYY-MM-DDTHH:mm:ssZ)`,
  };
}
