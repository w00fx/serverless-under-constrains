// AC-RUA-024 (BR-RUA-047): given a later billing export, when exact resource, ownership,
// operation, account, currency and usage-window correlation is possible, attributable USD usage is
// compared with the declared ceiling. Verification: unit, billing-export fixtures; cases from design
// §14: usage within the ceiling and usage above the ceiling. The fixtures are hand-written CUR 2.0
// exports (`fixtures/*.csv`); every expected value below is computed by hand from them and the
// OR-RUA-003 ceiling USD 5.00, never read back from the code.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildBillingImport } from '../../../src/billing-amendment/billing-import.ts';
import type { BillingImport } from '../../../src/record-contract/records/group-c/billing_import.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { LEDGER_ARN, PROVIDER_ARN, billingExportFixture, runImport } from './support/cur-export-builder.ts';

const validator = createRecordValidator();

function importFixture(name: string): BillingImport {
  const built = buildBillingImport(runImport(billingExportFixture(name)));
  assert.ok(built.ok, `fixture ${name} must import: ${JSON.stringify(built)}`);
  const verdict = validator.validateAs('billing_import', built.value as unknown as JsonValue);
  assert.ok(verdict.valid, `billing_import of ${name} must satisfy its schema: ${JSON.stringify(verdict)}`);
  return built.value;
}

describe('AC-RUA-024 attributable cost compared with the ceiling', () => {
  it('within-ceiling', () => {
    const record = importFixture('within-ceiling.csv');

    // 0.0000166667 (provider Invoke) + 1.25 (ledger requests) = 1.2500166667 <= 5.00.
    assert.equal(record.billed_cost_check, 'within_limit');
    assert.equal('attributed_total_usd' in record ? record.attributed_total_usd : undefined, '1.2500166667');
    assert.deepEqual(record.reasons, []);
    assert.equal(record.ceiling_usd, '5.00');
    assert.deepEqual(record.lines_used, [
      {
        line_id: 'row:1',
        product_code: 'AWSLambda',
        operation: 'Invoke',
        resource_id: PROVIDER_ARN,
        usage_start: '2026-10-05T10:00:00.000Z',
        usage_end: '2026-10-05T11:00:00.000Z',
        currency: 'USD',
        cost: '0.0000166667',
      },
      {
        line_id: 'row:2',
        product_code: 'AmazonDynamoDB',
        operation: 'PayPerRequestThroughput',
        resource_id: LEDGER_ARN,
        usage_start: '2026-10-05T11:00:00.000Z',
        usage_end: '2026-10-05T12:00:00.000Z',
        currency: 'USD',
        cost: '1.25',
      },
    ]);
    // Tax, another account, the baseline coordination table and the day before are excluded and listed.
    assert.deepEqual(
      record.exclusions.map((line) => [line.line_id, line.exclusion]),
      [
        ['row:3', 'TAX'],
        ['row:4', 'OTHER_ACCOUNT'],
        ['row:5', 'NOT_RUN_OWNED'],
        ['row:6', 'OUTSIDE_USAGE_WINDOW'],
      ],
    );
    assert.equal(record.attribution_window_start, '2026-10-05T10:00:00.000Z');
    assert.equal(record.attribution_window_end, '2026-10-05T12:00:00.000Z');
    assert.deepEqual(record.billing_export, {
      export_sha256: record.billing_export.export_sha256,
      period_start: '2026-10-01T00:00:00.000Z',
      period_end: '2026-11-01T00:00:00.000Z',
      period_final: true,
    });
  });

  it('above-ceiling', () => {
    const record = importFixture('above-ceiling.csv');

    // 3.10 + 1.95 = 5.05 > 5.00; the -4.00 credit is excluded, never netted against usage.
    assert.equal(record.billed_cost_check, 'breached');
    assert.equal('attributed_total_usd' in record ? record.attributed_total_usd : undefined, '5.05');
    assert.deepEqual(record.reasons, []);
    assert.deepEqual(
      record.lines_used.map((line) => [line.line_id, line.cost]),
      [
        ['row:1', '3.10'],
        ['row:2', '1.95'],
      ],
    );
    assert.deepEqual(
      record.exclusions.map((line) => [line.line_id, line.exclusion]),
      [['row:3', 'CREDIT']],
    );
  });
});
