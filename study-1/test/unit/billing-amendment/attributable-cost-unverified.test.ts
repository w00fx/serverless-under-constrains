// AC-RUA-034 (BR-RUA-047): given a later billing export, when attribution is incomplete or any
// attributable line is non-USD, billed-cost safety is `unverified`, and no proportional allocation or
// exchange-rate conversion occurs. Verification: unit, billing-export fixtures; cases from design §14:
// incomplete attribution, one non-USD line, mixed currencies. Expected values come from the spec and
// the hand-written fixtures, never from the code under test.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildBillingImport } from '../../../src/billing-amendment/billing-import.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { BillingImport } from '../../../src/record-contract/records/group-c/billing_import.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { billingExportFixture, runImport } from './support/cur-export-builder.ts';

const validator = createRecordValidator();

function importFixture(name: string): BillingImport {
  const built = buildBillingImport(runImport(billingExportFixture(name)));
  assert.ok(built.ok, `fixture ${name} must import: ${JSON.stringify(built)}`);
  const verdict = validator.validateAs('billing_import', built.value as unknown as JsonValue);
  assert.ok(verdict.valid, `billing_import of ${name} must satisfy its schema: ${JSON.stringify(verdict)}`);
  return built.value;
}

function assertUnverifiedWithoutTotal(record: BillingImport, codes: readonly string[]): void {
  assert.equal(record.billed_cost_check, 'unverified');
  assert.equal('attributed_total_usd' in record, false, 'an unverified check states no total (no allocation)');
  assert.deepEqual(
    record.reasons.map((reason) => [reason.code, reason.subject]),
    codes.map((code) => [code, 'BR-RUA-047']),
  );
}

describe('AC-RUA-034 attributable cost unverified', () => {
  it('incomplete-attribution', () => {
    const record = importFixture('incomplete-attribution.csv');

    // Row 2 is DynamoDB request usage in the run's account and window with a blank resource id: it may
    // be the run's or the baseline's, and nothing is apportioned between them.
    assertUnverifiedWithoutTotal(record, ['INCOMPLETE_ATTRIBUTION']);
    assert.match(record.reasons[0]?.detail ?? '', /^1 line\(s\): row:2 \(blank resource id\);/);
    assert.deepEqual(
      record.lines_used.map((line) => [line.line_id, line.cost]),
      [['row:1', '0.40']],
    );
    assert.deepEqual(record.exclusions, []);
  });

  it('non-usd-line', () => {
    const record = importFixture('non-usd-line.csv');

    // One attributable line billed in EUR: listed exactly as exported, never converted.
    assertUnverifiedWithoutTotal(record, ['NON_USD_LINE']);
    assert.match(record.reasons[0]?.detail ?? '', /^1 line\(s\): row:1 \(currency "EUR"\);/);
    assert.deepEqual(
      record.lines_used.map((line) => [line.line_id, line.currency, line.cost]),
      [['row:1', 'EUR', '0.37']],
    );
  });

  it('mixed-currencies', () => {
    const record = importFixture('mixed-currencies.csv');

    // USD and BRL attributable lines: the BRL line is non-USD and the set mixes currencies.
    assertUnverifiedWithoutTotal(record, ['NON_USD_LINE', 'MIXED_CURRENCY']);
    assert.match(record.reasons[1]?.detail ?? '', /^attributable lines use BRL, USD;/);
    assert.deepEqual(
      record.lines_used.map((line) => [line.line_id, line.currency, line.cost]),
      [
        ['row:1', 'USD', '0.40'],
        ['row:2', 'BRL', '2.15'],
      ],
    );
  });
});
