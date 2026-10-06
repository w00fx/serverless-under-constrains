// Group-C examples of finalized packages and their amendments: the package index, the package
// verification, the amendment index and the billing import (catalogue rows 79, 80, 84, 86).

import type { AmendmentIndex } from '../../../../../src/record-contract/records/group-c/amendment_index.ts';
import type {
  AttributedBillingLine,
  BillingImport,
} from '../../../../../src/record-contract/records/group-c/billing_import.ts';
import type { PackageIndex } from '../../../../../src/record-contract/records/group-c/package_index.ts';
import type {
  AmendmentLink,
  PackageVerification,
} from '../../../../../src/record-contract/records/group-c/package_verification.ts';
import type { MoneyDecimal } from '../../../../../src/record-contract/primitives.ts';
import {
  EXECUTION_MANIFEST_SHA256,
  PROBE_ID,
  RUN_ID,
  at,
  digest,
  uuid,
} from '../../group-b/support/record-builders.ts';
import { EXECUTION_MANIFEST_PATH, codedReason, indexEntry } from '../support/group-c-builders.ts';
import { groupCExample } from '../support/record-example.ts';
import type { GroupCExample } from '../support/record-example.ts';

const RUN_PACKAGE_INDEX_SHA256 = digest('run-package-index');

/**
 * The final index of a run package, sorted by path, excluding itself (BR-RUA-044).
 *
 * @example
 * runPackageIndex().execution_kind; // 'RUN'
 */
export function runPackageIndex(): PackageIndex {
  return {
    schema_version: 1,
    record_type: 'package_index',
    execution_kind: 'RUN',
    run_id: RUN_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    entries: [
      indexEntry(EXECUTION_MANIFEST_PATH, 'execution_manifest'),
      indexEntry('cleanup/cleanup-result.json', 'cleanup_result', 'derived'),
      indexEntry('coordination/coordination-journal.jsonl', 'coordination_journal'),
      indexEntry('late-evidence/late-evidence-assessment.json', 'late_evidence_assessment', 'derived'),
      indexEntry('summary/run-summary.json', 'run_summary', 'derived'),
      indexEntry(`trials/${uuid(0x601)}/evidence-index.json`, 'evidence_index', 'derived'),
    ],
    created_at: at(9000),
  };
}

/**
 * The final index of a probe package.
 *
 * @example
 * probePackageIndex().execution_kind; // 'TRANSPORT_PROBE'
 */
export function probePackageIndex(): PackageIndex {
  return {
    schema_version: 1,
    record_type: 'package_index',
    execution_kind: 'TRANSPORT_PROBE',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    entries: [indexEntry('probe/evidence-index.json', 'evidence_index', 'derived')],
    created_at: at(9010),
  };
}

function amendmentLink(sequence: number, kind: AmendmentLink['amendment_kind']): AmendmentLink {
  return {
    sequence,
    amendment_id: uuid(0x800 + sequence),
    amendment_kind: kind,
    amendment_index_sha256: digest(`amendment-index-${String(sequence)}`),
  };
}

/**
 * An eligible original package with no amendment selected (BR-RUA-044).
 *
 * @example
 * eligiblePackage().package_eligibility; // 'eligible'
 */
export function eligiblePackage(): PackageVerification {
  return {
    schema_version: 1,
    record_type: 'package_verification',
    run_id: RUN_ID,
    package_eligibility: 'eligible',
    package_ineligibility_reasons: [],
    original_package_index_sha256: RUN_PACKAGE_INDEX_SHA256,
    selected_amendment_head_sha256: null,
    selected_chain: [],
    known_descendants: [],
    evaluated_at: at(9100),
  };
}

/**
 * A selected chain whose descendant was left unselected makes the package ineligible (D-12).
 *
 * @example
 * ineligiblePackage().package_eligibility; // 'ineligible'
 */
export function ineligiblePackage(): PackageVerification {
  return {
    ...eligiblePackage(),
    package_eligibility: 'ineligible',
    package_ineligibility_reasons: [
      codedReason('UNSELECTED_DESCENDANT', 'amendment chain'),
      codedReason('UNINDEXED_FILE', 'summary/extra.json'),
    ],
    selected_amendment_head_sha256: digest('amendment-index-1'),
    selected_chain: [amendmentLink(1, 'LATE_EVIDENCE')],
    known_descendants: [amendmentLink(2, 'REASSESSMENT')],
  };
}

/**
 * The operator selected a head that resolves to no known amendment (design §8.16 step 6): the
 * verifier records the requested head with an empty chain and the UNKNOWN_HEAD reason.
 *
 * @example
 * unknownHeadPackage().selected_chain; // []
 */
export function unknownHeadPackage(): PackageVerification {
  return {
    ...eligiblePackage(),
    package_eligibility: 'ineligible',
    package_ineligibility_reasons: [codedReason('UNKNOWN_HEAD', 'selected amendment head')],
    selected_amendment_head_sha256: digest('amendment-index-unknown'),
    selected_chain: [],
  };
}

/**
 * The first amendment of a run package: its parent is the original index (BR-RUA-043).
 *
 * @example
 * firstAmendmentIndex().parent_amendment_index_sha256; // null
 */
export function firstAmendmentIndex(): AmendmentIndex {
  return {
    schema_version: 1,
    record_type: 'amendment_index',
    run_id: RUN_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    amendment_id: uuid(0x801),
    amendment_kind: 'BILLING',
    sequence: 1,
    original_package_index_sha256: RUN_PACKAGE_INDEX_SHA256,
    parent_amendment_index_sha256: null,
    entries: [
      indexEntry('payload/billing-export.csv', 'billing_export_file'),
      indexEntry('payload/billing-import.json', 'billing_import', 'derived'),
    ],
    created_at: at(9200),
  };
}

/**
 * The second amendment, chained to the first by its index digest.
 *
 * @example
 * chainedAmendmentIndex().sequence; // 2
 */
export function chainedAmendmentIndex(): AmendmentIndex {
  return {
    ...firstAmendmentIndex(),
    amendment_id: uuid(0x802),
    amendment_kind: 'OPERATIONAL_RECOVERY',
    sequence: 2,
    parent_amendment_index_sha256: digest('amendment-index-1'),
    entries: [indexEntry('payload/operational-recovery-record.json', 'operational_recovery_record', 'derived')],
    created_at: at(9300),
  };
}

const USAGE_WINDOW = { attribution_window_start: at(0), attribution_window_end: at(9000) } as const;

const MONEY_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

// `decimal.ts` exports no MoneyDecimal guard, so the example checks the `_defs` money_decimal
// pattern itself before branding.
function money(value: string): MoneyDecimal {
  if (!MONEY_DECIMAL.test(value)) {
    throw new RangeError(
      `money(${JSON.stringify(value)}) is not a nonnegative decimal; expected ${String(MONEY_DECIMAL)}`,
    );
  }
  return value as MoneyDecimal;
}

function billingLine(lineId: string, currency: string, cost: string): AttributedBillingLine {
  return {
    line_id: lineId,
    product_code: 'AWSLambda',
    operation: 'Invoke',
    resource_id: 'arn:aws:lambda:eu-west-1:000000000000:function:rua-provider',
    usage_start: at(100),
    usage_end: at(8000),
    currency,
    cost: money(cost),
  };
}

/**
 * Exact USD attribution within the ceiling (BR-RUA-047).
 *
 * @example
 * withinLimitBilling().billed_cost_check; // 'within_limit'
 */
export function withinLimitBilling(): BillingImport {
  return {
    schema_version: 1,
    record_type: 'billing_import',
    run_id: RUN_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    original_package_index_sha256: RUN_PACKAGE_INDEX_SHA256,
    billing_export: {
      export_sha256: digest('billing-export'),
      period_start: at(-86_400_000),
      period_end: at(86_400_000),
      period_final: true,
    },
    ...USAGE_WINDOW,
    lines_used: [billingLine('line-0001', 'USD', '0.0042')],
    exclusions: [{ line_id: 'line-0002', exclusion: 'TAX', detail: 'sales tax is never attributed' }],
    ceiling_usd: money('5.00'),
    billed_cost_check: 'within_limit',
    attributed_total_usd: money('0.0042'),
    reasons: [],
    imported_at: at(9400),
  };
}

/**
 * A period that is not final, with a line in another currency: unverified, no total.
 *
 * @example
 * unverifiedBilling().billed_cost_check; // 'unverified'
 */
export function unverifiedBilling(): BillingImport {
  return {
    schema_version: 1,
    record_type: 'billing_import',
    run_id: RUN_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    original_package_index_sha256: RUN_PACKAGE_INDEX_SHA256,
    billing_export: { ...withinLimitBilling().billing_export, period_final: false },
    ...USAGE_WINDOW,
    lines_used: [billingLine('line-0001', 'USD', '0.0042'), billingLine('line-0003', 'EUR', '0.0100')],
    exclusions: [],
    ceiling_usd: money('5.00'),
    billed_cost_check: 'unverified',
    reasons: [codedReason('INCOMPLETE_PERIOD', 'billing export'), codedReason('NON_USD_LINE', 'line-0003')],
    imported_at: at(9410),
  };
}

export const PACKAGE_EXAMPLES: readonly GroupCExample[] = [
  groupCExample('package_index', runPackageIndex()),
  groupCExample('package_index (probe)', probePackageIndex()),
  groupCExample('package_verification', eligiblePackage()),
  groupCExample('package_verification (ineligible)', ineligiblePackage()),
  groupCExample('package_verification (unknown head)', unknownHeadPackage()),
  groupCExample('amendment_index', firstAmendmentIndex()),
  groupCExample('amendment_index (chained)', chainedAmendmentIndex()),
  groupCExample('billing_import', withinLimitBilling()),
  groupCExample('billing_import (unverified)', unverifiedBilling()),
];
