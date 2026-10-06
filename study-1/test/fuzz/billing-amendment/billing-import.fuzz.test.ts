// Design §12.5 row `parseCurCsv` (WP-18): "non-USD gives `unverified`", over the whole billing import.
// For any export, the import never throws and every record it writes satisfies the `billing_import`
// schema. For generated exports, every line lands in exactly one place (attributed, excluded, or
// counted in an unverified reason), a non-USD attributable line always makes the check `unverified`
// without a total, and a conclusive check states the exact USD sum and its comparison with the ceiling.
// A conclusive check also never leaves out a line that may be run usage (BR-RUA-047: the safety
// boundary covers identifiable run-owned usage; missing identities and shared charges give
// `unverified`); that oracle is written from the spec, independently of the classification order.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { buildBillingImport } from '../../../src/billing-amendment/billing-import.ts';
import { CUR_LINE_COLUMNS } from '../../../src/billing-amendment/cur-export.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { BillingImport } from '../../../src/record-contract/records/group-c/billing_import.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import {
  ACCOUNT_ID,
  COORDINATION_ARN,
  LEDGER_ARN,
  OTHER_RUN_ID,
  PROVIDER_ARN,
  RUN_CEILING_USD,
  RUN_ID,
  csvBytes,
  curCsv,
  curRecord,
  runImport,
} from '../../unit/billing-amendment/support/cur-export-builder.ts';
import type { CurRecordValues } from '../../unit/billing-amendment/support/cur-export-builder.ts';

const validator = createRecordValidator();

function assertSchemaValid(record: BillingImport): void {
  const verdict = validator.validateAs('billing_import', record as unknown as JsonValue);
  assert.ok(verdict.valid, JSON.stringify(verdict));
}

// Mostly attributable lines (repeated values weight the draw), so every outcome is reached; the rest
// exercise each exclusion and unverified path.
const lineFields = fc.record({
  account: fc.constantFrom(ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID, '210987654321', ''),
  type: fc.constantFrom(
    'Usage',
    'Usage',
    'Usage',
    'Usage',
    'Usage',
    'Tax',
    'Credit',
    'SavingsPlanCoveredUsage',
    'DiscountedUsage',
  ),
  owner: fc.constantFrom(
    [PROVIDER_ARN, 'AWSLambda', 'Invoke'],
    [PROVIDER_ARN, 'AWSLambda', 'Invoke'],
    [PROVIDER_ARN, 'AWSLambda', 'Invoke'],
    [LEDGER_ARN, 'AmazonDynamoDB', 'PayPerRequestThroughput'],
    [PROVIDER_ARN, 'AWSLambda', 'GetFunction'],
    [COORDINATION_ARN, 'AmazonDynamoDB', 'PayPerRequestThroughput'],
    ['', 'AmazonDynamoDB', 'PayPerRequestThroughput'],
    ['', 'AmazonS3', 'GetObject'],
    ['constructor', '__proto__', 'toString'],
  ),
  hours: fc.constantFrom([10, 11], [10, 11], [11, 12], [10, 12], [9, 10], [12, 13], [9, 11], [11, 13]),
  currency: fc.constantFrom('USD', 'USD', 'USD', 'USD', 'USD', 'USD', 'EUR', 'BRL', 'usd'),
  cost: fc.oneof(
    { arbitrary: fc.bigInt({ min: 0n, max: 6n * 10n ** 6n }).map(microDollars), weight: 8 },
    { arbitrary: fc.constantFrom('1.25E-5', '0', '5.00', 'Infinity', '1e400', '-1', 'NaN'), weight: 1 },
  ),
  tag: fc.constantFrom(RUN_ID, RUN_ID, RUN_ID, OTHER_RUN_ID, ''),
});

type LineFields = typeof lineFields extends fc.Arbitrary<infer T> ? T : never;

function exportRecord(line: LineFields): CurRecordValues {
  return curRecord({
    [CUR_LINE_COLUMNS.usage_account_id]: line.account,
    [CUR_LINE_COLUMNS.line_item_type]: line.type,
    [CUR_LINE_COLUMNS.resource_id]: line.owner[0],
    [CUR_LINE_COLUMNS.product_code]: line.owner[1],
    [CUR_LINE_COLUMNS.operation]: line.owner[2],
    [CUR_LINE_COLUMNS.usage_start]: `2026-10-05T${String(line.hours[0]).padStart(2, '0')}:00:00Z`,
    [CUR_LINE_COLUMNS.usage_end]: `2026-10-05T${String(line.hours[1]).padStart(2, '0')}:00:00Z`,
    [CUR_LINE_COLUMNS.currency]: line.currency,
    [CUR_LINE_COLUMNS.cost]: line.cost,
    [CUR_LINE_COLUMNS.run_tag]: line.tag,
  });
}

const lineArbitrary: fc.Arbitrary<CurRecordValues> = lineFields.map(exportRecord);

// The line types BR-RUA-047 itself excludes (tax, credits); every other generated type is usage.
const SPEC_EXCLUDED_TYPES: ReadonlySet<string> = new Set(['Tax', 'Credit']);
const RUN_RESOURCES: ReadonlySet<string> = new Set([PROVIDER_ARN, LEDGER_ARN]);
const WINDOW_HOURS = [10, 12] as const;

// May the line be the run's usage? Usage (not tax or credit) in the run account or with no account,
// overlapping the 10:00-12:00 window, that names a run resource or carries the run tag.
function mayBeRunUsage(line: LineFields): boolean {
  const inAccount = line.account === ACCOUNT_ID || line.account === '';
  const overlaps = line.hours[0] < WINDOW_HOURS[1] && line.hours[1] > WINDOW_HOURS[0];
  const identified = RUN_RESOURCES.has(line.owner[0]) || line.tag === RUN_ID;
  return !SPEC_EXCLUDED_TYPES.has(line.type) && inAccount && overlaps && identified;
}

function microDollars(units: bigint): string {
  return `${String(units / 10n ** 6n)}.${String(units % 10n ** 6n).padStart(6, '0')}`;
}

// Independent reference: money decimals as scaled BigInt with 12 fractional digits (every cost the
// generator writes has at most 7).
function toPicoUnits(amount: string): bigint {
  const [integer = '', fraction = ''] = amount.split('.');
  return BigInt(integer) * 10n ** 12n + BigInt(fraction.padEnd(12, '0'));
}

function unattributedCount(record: BillingImport): number {
  return record.reasons
    .filter((reason) => reason.code === 'INCOMPLETE_ATTRIBUTION' || reason.code === 'SHARED_OR_UNOWNED_CHARGE')
    .reduce((total, reason) => total + Number(/^(\d+) line\(s\)/.exec(reason.detail)?.[1] ?? '0'), 0);
}

describe('buildBillingImport is total over arbitrary export bytes (property)', () => {
  it('refuses or writes a schema-valid record for any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        const built = buildBillingImport(runImport(bytes));
        if (built.ok) {
          assertSchemaValid(built.value);
        } else {
          assert.ok(built.error.length > 0);
        }
      }),
      fuzzParameters(),
    );
  });
});

describe('buildBillingImport over generated exports (property)', () => {
  it('never concludes while a line that may be run usage is left out of the total', () => {
    const parameters = fuzzParameters();
    let conclusiveWithRunUsage = 0;
    fc.assert(
      fc.property(fc.array(lineFields, { minLength: 1, maxLength: 6 }), (fields) => {
        const built = buildBillingImport(runImport(csvBytes(curCsv(fields.map(exportRecord)))));
        assert.ok(built.ok, JSON.stringify(built));
        if (built.value.billed_cost_check === 'unverified') {
          return;
        }
        const used = new Set(built.value.lines_used.map((line) => line.line_id));
        fields.forEach((line, index) => {
          const lineId = `row:${String(index + 1)}`;
          assert.ok(!mayBeRunUsage(line) || used.has(lineId), `${lineId} may be run usage but is not in the total`);
        });
        conclusiveWithRunUsage += fields.some(mayBeRunUsage) ? 1 : 0;
      }),
      parameters,
    );
    // Non-vacuity: a real budget reaches conclusive checks that do include run usage.
    if (parameters.numRuns >= 1000) {
      assert.ok(conclusiveWithRunUsage > 0, 'no conclusive check with run usage was generated');
    }
  });

  it('places every line once, never totals non-USD lines, and compares the exact USD sum', () => {
    const parameters = fuzzParameters();
    const outcomes = new Set<string>();
    fc.assert(
      fc.property(fc.array(lineArbitrary, { minLength: 1, maxLength: 6 }), (lines) => {
        const built = buildBillingImport(runImport(csvBytes(curCsv(lines))));
        assert.ok(built.ok, JSON.stringify(built));
        const record = built.value;
        assertSchemaValid(record);
        outcomes.add(record.billed_cost_check);

        assert.equal(record.lines_used.length + record.exclusions.length + unattributedCount(record), lines.length);
        if (record.lines_used.some((line) => line.currency !== 'USD')) {
          assert.equal(record.billed_cost_check, 'unverified');
          assert.ok(record.reasons.some((reason) => reason.code === 'NON_USD_LINE'));
        }
        if (record.billed_cost_check === 'unverified') {
          assert.equal('attributed_total_usd' in record, false);
          return;
        }
        const total = record.lines_used.reduce((sum, line) => sum + toPicoUnits(line.cost), 0n);
        assert.equal(toPicoUnits(record.attributed_total_usd), total);
        assert.equal(record.billed_cost_check, total <= toPicoUnits(RUN_CEILING_USD) ? 'within_limit' : 'breached');
      }),
      parameters,
    );
    // Non-vacuity: a real budget reaches every outcome of the check.
    if (parameters.numRuns >= 1000) {
      assert.deepEqual([...outcomes].sort(), ['breached', 'unverified', 'within_limit']);
    }
  });
});
