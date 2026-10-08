// Billing-export test material (AC-RUA-024, AC-RUA-034): one execution's frozen facts and a builder
// of CUR 2.0 CSV exports. The values are chosen from the spec and design §8.17, never read back from
// the code under test: a run in account 123456789012 whose first mutation is 10:17:03.120Z and whose
// cleanup became terminal at 11:02Z on 2026-10-05, so the attribution window is 10:00Z-12:00Z.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { AttributionContextInput } from '../../../../src/billing-amendment/attribution-context.ts';
import type { BillingImportInput } from '../../../../src/billing-amendment/billing-import.ts';
import { CUR_LINE_COLUMNS, CUR_PERIOD_COLUMNS } from '../../../../src/billing-amendment/cur-export.ts';
import type { Uuid4 } from '../../../../src/record-contract/primitives.ts';

export const RUN_ID = '6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4' as Uuid4;
export const OTHER_RUN_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' as Uuid4;
export const ACCOUNT_ID = '123456789012';
export const PROVIDER_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:suc-run-provider';
export const LEDGER_ARN = 'arn:aws:dynamodb:us-east-1:123456789012:table/suc-run-ledger';
export const COORDINATION_ARN = 'arn:aws:dynamodb:us-east-1:123456789012:table/suc-study-1-coordination';
export const MANIFEST_SHA256 = 'a'.repeat(64);
export const PACKAGE_INDEX_SHA256 = 'b'.repeat(64);
export const IMPORTED_AT = '2026-11-04T09:00:00.000Z';
/** OR-RUA-003 / OR-RUA-005: estimated attributable-usage ceiling USD 5.00. */
export const RUN_CEILING_USD = '5.00';

/** The header every builder export carries, in this order. */
export const CUR_HEADER: readonly string[] = [
  CUR_LINE_COLUMNS.usage_account_id,
  CUR_LINE_COLUMNS.line_item_type,
  CUR_LINE_COLUMNS.resource_id,
  CUR_LINE_COLUMNS.product_code,
  CUR_LINE_COLUMNS.operation,
  CUR_LINE_COLUMNS.usage_start,
  CUR_LINE_COLUMNS.usage_end,
  CUR_LINE_COLUMNS.currency,
  CUR_LINE_COLUMNS.cost,
  CUR_LINE_COLUMNS.run_tag,
  CUR_PERIOD_COLUMNS.start,
  CUR_PERIOD_COLUMNS.end,
  CUR_PERIOD_COLUMNS.invoice,
];

/** One export record by column name; every column defaults to an attributable run-owned Lambda line. */
export type CurRecordValues = Readonly<Record<string, string>>;

const ATTRIBUTABLE_RECORD: CurRecordValues = {
  [CUR_LINE_COLUMNS.usage_account_id]: ACCOUNT_ID,
  [CUR_LINE_COLUMNS.line_item_type]: 'Usage',
  [CUR_LINE_COLUMNS.resource_id]: PROVIDER_ARN,
  [CUR_LINE_COLUMNS.product_code]: 'AWSLambda',
  [CUR_LINE_COLUMNS.operation]: 'Invoke',
  [CUR_LINE_COLUMNS.usage_start]: '2026-10-05T10:00:00Z',
  [CUR_LINE_COLUMNS.usage_end]: '2026-10-05T11:00:00Z',
  [CUR_LINE_COLUMNS.currency]: 'USD',
  [CUR_LINE_COLUMNS.cost]: '0.5',
  [CUR_LINE_COLUMNS.run_tag]: RUN_ID,
  [CUR_PERIOD_COLUMNS.start]: '2026-10-01T00:00:00Z',
  [CUR_PERIOD_COLUMNS.end]: '2026-11-01T00:00:00Z',
  [CUR_PERIOD_COLUMNS.invoice]: 'EUINUS26-000123',
};

/**
 * An export record: the attributable defaults with `overrides` applied.
 *
 * @example
 * curRecord({ [CUR_LINE_COLUMNS.currency]: 'EUR' });
 */
export function curRecord(overrides: CurRecordValues = {}): CurRecordValues {
  return { ...ATTRIBUTABLE_RECORD, ...overrides };
}

/**
 * Serializes records as RFC 4180 CSV under `header` (quoting only fields that need it).
 *
 * @example
 * curCsv([curRecord()]); // header line plus one record, CRLF terminated
 */
export function curCsv(
  records: readonly CurRecordValues[],
  header: readonly string[] = CUR_HEADER,
  terminator = '\r\n',
): string {
  const lines = [header, ...records.map((record) => header.map((column) => cellOf(record, column)))];
  return lines.map((fields) => fields.map(csvField).join(',')).join(terminator) + terminator;
}

// Own properties only, so a column named `__proto__` or `constructor` reads as empty (A-05).
function cellOf(record: CurRecordValues, column: string): string {
  return Object.hasOwn(record, column) ? String(record[column]) : '';
}

/**
 * The UTF-8 bytes of a CSV text.
 *
 * @example
 * csvBytes(curCsv([curRecord()]));
 */
export function csvBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Quotes one field the RFC 4180 way when it holds a comma, a quote or a line break.
 *
 * @example
 * csvField('a,b'); // '"a,b"'
 */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The run's attribution inputs (design §8.17). */
export const RUN_CONTEXT: AttributionContextInput = {
  identity: { execution_kind: 'RUN', run_id: RUN_ID },
  account_id: ACCOUNT_ID,
  resource_identities: [PROVIDER_ARN, LEDGER_ARN],
  charge_allowlist: [
    { product_code: 'AWSLambda', operations: ['Invoke'] },
    { product_code: 'AmazonDynamoDB', operations: ['PayPerRequestThroughput'] },
  ],
  first_mutation_at: '2026-10-05T10:17:03.120Z',
  cleanup_terminal_at: '2026-10-05T11:02:00.000Z',
};

/**
 * A billing import of `exportBytes` for the run, with the run ceiling.
 *
 * @example
 * buildBillingImport(runImport(csvBytes(curCsv([curRecord()]))));
 */
export function runImport(exportBytes: Uint8Array, overrides: Partial<BillingImportInput> = {}): BillingImportInput {
  return {
    context: RUN_CONTEXT,
    execution_manifest_sha256: MANIFEST_SHA256,
    original_package_index_sha256: PACKAGE_INDEX_SHA256,
    export_bytes: exportBytes,
    ceiling_usd: RUN_CEILING_USD,
    imported_at: IMPORTED_AT,
    ...overrides,
  };
}

/**
 * The exact bytes of a hand-written billing-export fixture under `../fixtures/`.
 *
 * @example
 * billingExportFixture('within-ceiling.csv');
 */
export function billingExportFixture(name: string): Uint8Array {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
}
