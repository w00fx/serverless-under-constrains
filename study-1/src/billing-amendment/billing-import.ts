// The `billing_import` record (catalogue row 86), the payload of a BILLING amendment (BR-RUA-043,
// BR-RUA-047). It states the authoritative export by digest and billing period, the attribution
// window, every attributed line, every excluded line with its reason, the declared ceiling and the
// billed-cost check. The amendment package itself (`payload/billing-import.json` beside the exact
// export bytes under `payload/billing-export/`, then `amendment-index.json`) is assembled by the
// operator CLI with `evidence-package`'s `buildAmendment`: `billing-amendment` and `evidence-package`
// share layer L2, which forbids a direct import (design §5.4; evidence/WP-18/decisions.md).

import { sha256Hex, isSha256Hex } from '../record-contract/digests.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { MoneyDecimal, Result, Sha256Hex, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { BillingImport } from '../record-contract/records/group-c/billing_import.ts';
import { isUtcMillis } from '../record-contract/timestamps.ts';
import { parseAttributionContext } from './attribution-context.ts';
import type { AttributionContext, AttributionContextInput } from './attribution-context.ts';
import { deriveBilledCostCheck, periodReasons } from './billed-cost-check.ts';
import { parseCurCsv } from './cur-csv.ts';
import type { CurTable } from './cur-csv.ts';
import { readCurLines, readExportPeriod } from './cur-export.ts';
import type { ExportBillingPeriod } from './cur-export.ts';
import { correlateBillingLines } from './line-attribution.ts';
import type { AttributionResult } from './line-attribution.ts';
import { isMoneyDecimal } from './money-decimal.ts';

/** Everything one billing import reads: the frozen package facts and the export file's exact bytes. */
export interface BillingImportInput {
  readonly context: AttributionContextInput;
  readonly execution_manifest_sha256: string;
  readonly original_package_index_sha256: string;
  /**
   * The export's only data file as stored in the amendment (gzip or plain CSV); its digest is
   * recorded. Lines of a delivery split across several files cannot be seen here, so the caller
   * imports only a delivery whose Data Exports manifest lists this one file (WP-18 review residual).
   */
  readonly export_bytes: Uint8Array;
  /** The execution manifest's declared `safety.ceiling_usd` (OR-RUA-003..005). */
  readonly ceiling_usd: string;
  readonly imported_at: string;
}

interface CheckedScalars {
  readonly execution_manifest_sha256: Sha256Hex;
  readonly original_package_index_sha256: Sha256Hex;
  readonly ceiling_usd: MoneyDecimal;
  readonly imported_at: UtcMillis;
}

/**
 * Builds the `billing_import` record of one export, or every reason it cannot be built: unusable
 * inputs, an export that is not a readable CSV, or an export whose billing period cannot be read.
 * Incomplete attribution is not a refusal: it yields an `unverified` check with its reasons.
 *
 * @example
 * const record = buildBillingImport({ context, execution_manifest_sha256, original_package_index_sha256,
 *   export_bytes, ceiling_usd: '5.00', imported_at: '2026-11-04T09:00:00.000Z' });
 * if (record.ok) payload.push({ path: 'payload/billing-import.json', bytes: serializeRecordFile(record.value) });
 */
export function buildBillingImport(input: BillingImportInput): Result<BillingImport, readonly StructuredReason[]> {
  const context = parseAttributionContext(input.context);
  const scalars = checkScalars(input);
  if (!context.ok || !scalars.ok) {
    return err([...(context.ok ? [] : context.error), ...(scalars.ok ? [] : scalars.error)]);
  }
  const table = parseCurCsv(input.export_bytes);
  if (!table.ok) {
    return err([table.error]);
  }
  const period = readExportPeriod(table.value);
  if (!period.ok) {
    return err([period.error]);
  }
  const attribution = attributeExport(table.value, period.value, context.value);
  return ok({
    schema_version: 1,
    record_type: 'billing_import',
    ...executionIdentityFields(input.context.identity),
    execution_manifest_sha256: scalars.value.execution_manifest_sha256,
    original_package_index_sha256: scalars.value.original_package_index_sha256,
    billing_export: { export_sha256: sha256Hex(input.export_bytes), ...period.value },
    attribution_window_start: attribution.window.start,
    attribution_window_end: attribution.window.end,
    lines_used: attribution.lines_used,
    exclusions: attribution.exclusions,
    ceiling_usd: scalars.value.ceiling_usd,
    ...deriveBilledCostCheck(attribution, scalars.value.ceiling_usd),
    imported_at: scalars.value.imported_at,
  });
}

// Attribution plus the period reasons; an export without the line columns attributes nothing.
function attributeExport(table: CurTable, period: ExportBillingPeriod, context: AttributionContext): AttributionResult {
  const lines = readCurLines(table);
  const attribution = lines.ok
    ? correlateBillingLines(lines.value, context)
    : { window: context.window, lines_used: [], exclusions: [], reasons: [lines.error] };
  return { ...attribution, reasons: [...attribution.reasons, ...periodReasons(period, context.window)] };
}

function checkScalars(input: BillingImportInput): Result<CheckedScalars, readonly StructuredReason[]> {
  const manifest = checked(input.execution_manifest_sha256, isSha256Hex, 'execution_manifest_sha256', 'a sha256');
  const index = checked(input.original_package_index_sha256, isSha256Hex, 'original_package_index_sha256', 'a sha256');
  const ceiling = checked(input.ceiling_usd, isMoneyDecimal, 'ceiling_usd', 'a money decimal');
  const importedAt = checked(input.imported_at, isUtcMillis, 'imported_at', 'UTC millis');
  if (!manifest.ok || !index.ok || !ceiling.ok || !importedAt.ok) {
    return err([manifest, index, ceiling, importedAt].flatMap((field) => (field.ok ? [] : [field.error])));
  }
  return ok({
    execution_manifest_sha256: manifest.value,
    original_package_index_sha256: index.value,
    ceiling_usd: ceiling.value,
    imported_at: importedAt.value,
  });
}

function checked<T extends string>(
  value: string,
  guard: (candidate: unknown) => candidate is T,
  field: string,
  shape: string,
): Result<T, StructuredReason> {
  return guard(value) ? ok(value) : err(inputReason(`${field} ${boundedJsonText(value)} is not ${shape}`));
}

function inputReason(problem: string): StructuredReason {
  return {
    code: 'INVALID_BILLING_IMPORT_INPUT',
    subject: 'BR-RUA-047',
    detail: `${problem}; expected lowercase sha256 digests, a money decimal ceiling (^(0|[1-9][0-9]*)(\\.[0-9]+)?$) and imported_at as YYYY-MM-DDTHH:mm:ss.SSSZ`,
  };
}
