// Catalogue group C row 86 (design §6.2, §8.17): the payload of a `BILLING` amendment
// (BR-RUA-047). Exact correlation only: no exchange-rate conversion, no proportional allocation.

import type { MoneyDecimal, Sha256Hex, StructuredReason, UtcMillis } from '../../primitives.ts';
import type { ExecutionCorrelation } from './shared-shapes.ts';
import type { BillingExclusionCode, BillingUnverifiedCode } from './vocabulary.ts';

/** The authoritative export the lines came from. */
export interface BillingExportSource {
  readonly export_sha256: Sha256Hex;
  readonly period_start: UtcMillis;
  readonly period_end: UtcMillis;
  /** False while the provider may still restate the period. */
  readonly period_final: boolean;
}

/** One usage line attributed to the run by exact identity. */
export interface AttributedBillingLine {
  readonly line_id: string;
  readonly product_code: string;
  readonly operation: string;
  readonly resource_id: string;
  readonly usage_start: UtcMillis;
  readonly usage_end: UtcMillis;
  /** ISO 4217 code exactly as exported; a non-USD line makes the check `unverified`. */
  readonly currency: string;
  readonly cost: MoneyDecimal;
}

/** A candidate line left out of attribution, with its reason. */
export interface ExcludedBillingLine {
  readonly line_id: string;
  readonly exclusion: BillingExclusionCode;
  readonly detail: string;
}

/** A structured reason whose code makes the billed-cost check `unverified`. */
export type BillingUnverifiedReason = StructuredReason & { readonly code: BillingUnverifiedCode };

/** A conclusive check states the exact USD total; an `unverified` check states why instead. */
export type BilledCostOutcome =
  | {
      readonly billed_cost_check: 'within_limit' | 'breached';
      readonly attributed_total_usd: MoneyDecimal;
      readonly reasons: readonly [];
    }
  | {
      readonly billed_cost_check: 'unverified';
      readonly reasons: readonly [BillingUnverifiedReason, ...BillingUnverifiedReason[]];
    };

interface BillingImportFields {
  readonly schema_version: 1;
  readonly record_type: 'billing_import';
  readonly original_package_index_sha256: Sha256Hex;
  readonly billing_export: BillingExportSource;
  /** `[floor_hour(first mutation), ceil_hour(cleanup terminal))` (design §8.17). */
  readonly attribution_window_start: UtcMillis;
  readonly attribution_window_end: UtcMillis;
  readonly lines_used: readonly AttributedBillingLine[];
  readonly exclusions: readonly ExcludedBillingLine[];
  readonly ceiling_usd: MoneyDecimal;
  readonly imported_at: UtcMillis;
}

/** Schema: `schemas/group-c/billing_import.schema.json`. */
export type BillingImport = ExecutionCorrelation & BillingImportFields & BilledCostOutcome;
