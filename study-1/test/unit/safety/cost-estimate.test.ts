// The admission cost estimate (BR-RUA-046, D-19): exact pricing, rounding up to cents, refusal of
// unpriced or malformed lines, and the ceiling comparison.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MoneyDecimal } from '../../../src/record-contract/primitives.ts';
import { estimateAttributableCost, estimateWithinCeiling } from '../../../src/safety/cost-estimate.ts';
import { PRICE_CEILINGS } from '../../../src/safety/price-ceilings.ts';
import type { PriceCeiling } from '../../../src/safety/price-ceilings.ts';
import { planExecutionResources } from '../../../src/safety/resource-plan.ts';
import type { ResourcePlan } from '../../../src/safety/resource-plan.ts';

const usd = (text: string): MoneyDecimal => text as MoneyDecimal;
const RUN_PLAN = planExecutionResources({ kind: 'RUN', active_ms: 4_500_000, treatment_poll_interval_ms: 250 });

describe('estimateAttributableCost', () => {
  it('prices the canonical run at USD 0.28, line by line exactly', () => {
    const estimate = estimateAttributableCost(RUN_PLAN, PRICE_CEILINGS);
    assert.ok(estimate.ok);
    assert.equal(estimate.value.estimated_cost_usd, '0.28');
    assert.deepEqual(estimate.value.resource_counts, RUN_PLAN.resource_counts);
    assert.deepEqual(
      estimate.value.lines.map((line) => [line.meter, line.quantity, line.usd_per_unit, line.cost_usd]),
      [
        ['lambda_requests', 18_000, '0.0000002', '0.0036'],
        ['lambda_gb_seconds', 9_000, '0.0000166667', '0.1500003'],
        ['lambda_durable_operations', 4_500, '0.000008', '0.036'],
        ['dynamodb_write_request_units', 22_500, '0.000000625', '0.0140625'],
        ['dynamodb_read_request_units', 90_000, '0.000000125', '0.01125'],
        ['dynamodb_stream_read_request_units', 18_000, '0.0000002', '0.0036'],
        ['sqs_fifo_requests', 90_000, '0.0000005', '0.045'],
        ['sqs_standard_requests', 4_500, '0.0000004', '0.0018'],
        ['cloudwatch_logs_ingested_mb', 18, '0.0005', '0.009'],
      ],
    );
  });

  it('prices the probe, and both validations, within their ceilings', () => {
    const cases = [
      [{ kind: 'TRANSPORT_PROBE', active_ms: 600_000 }, '0.03'],
      [{ kind: 'VARIANT_VALIDATION', variant_id: 'durable', active_ms: 4_500_000 }, '0.22'],
      [{ kind: 'VARIANT_VALIDATION', variant_id: 'conventional', active_ms: 4_500_000 }, '0.18'],
    ] as const;
    for (const [input, expected] of cases) {
      const estimate = estimateAttributableCost(
        planExecutionResources({ ...input, treatment_poll_interval_ms: 250 }),
        PRICE_CEILINGS,
      );
      assert.ok(estimate.ok);
      assert.equal(estimate.value.estimated_cost_usd, expected, input.kind);
    }
  });

  it('refuses a meter without a ceiling or with two', () => {
    const missing = estimateAttributableCost(RUN_PLAN, PRICE_CEILINGS.slice(1));
    assert.ok(!missing.ok);
    assert.deepEqual(missing.error, [
      {
        code: 'PRICE_CEILING_MISSING',
        subject: 'BR-RUA-046',
        detail: 'meter lambda_requests has 0 price ceilings; expected exactly one committed ceiling',
      },
    ]);
    const first: PriceCeiling | undefined = PRICE_CEILINGS[0];
    assert.ok(first !== undefined);
    const doubled = estimateAttributableCost(RUN_PLAN, [...PRICE_CEILINGS, first]);
    assert.ok(!doubled.ok);
    assert.equal(
      doubled.error[0]?.detail,
      'meter lambda_requests has 2 price ceilings; expected exactly one committed ceiling',
    );
  });

  it('refuses an unreadable price', () => {
    const prices = PRICE_CEILINGS.map((price) =>
      price.meter === 'sqs_standard_requests' ? { ...price, usd_per_unit: usd('-0.1') } : price,
    );
    const estimate = estimateAttributableCost(RUN_PLAN, prices);
    assert.ok(!estimate.ok);
    assert.deepEqual(estimate.error, [
      {
        code: 'PRICE_CEILING_INVALID',
        subject: 'BR-RUA-046',
        detail:
          'meter sqs_standard_requests is priced "-0.1"; expected a nonnegative decimal with at most 12 fraction digits',
      },
    ]);
  });

  it('refuses a planned quantity that is negative, fractional or unsafe, one reason each', () => {
    const plan: ResourcePlan = {
      usage: [
        { meter: 'lambda_requests', quantity: -1 },
        { meter: 'lambda_gb_seconds', quantity: 1.5 },
        { meter: 'lambda_durable_operations', quantity: Number.MAX_SAFE_INTEGER + 1 },
        { meter: 'sqs_standard_requests', quantity: 0 },
      ],
      resource_counts: {},
    };
    const estimate = estimateAttributableCost(plan, PRICE_CEILINGS);
    assert.ok(!estimate.ok);
    assert.deepEqual(
      estimate.error.map((reason) => [reason.code, reason.detail]),
      [
        ['PLANNED_QUANTITY_INVALID', 'meter lambda_requests plans -1; expected a nonnegative safe integer'],
        ['PLANNED_QUANTITY_INVALID', 'meter lambda_gb_seconds plans 1.5; expected a nonnegative safe integer'],
        [
          'PLANNED_QUANTITY_INVALID',
          'meter lambda_durable_operations plans 9007199254740992; expected a nonnegative safe integer',
        ],
      ],
    );
  });

  it('rounds a sub-cent total up to one cent and an empty plan to zero', () => {
    const tiny = estimateAttributableCost(
      { usage: [{ meter: 'lambda_requests', quantity: 1 }], resource_counts: { functions: 1 } },
      PRICE_CEILINGS,
    );
    assert.ok(tiny.ok);
    assert.equal(tiny.value.estimated_cost_usd, '0.01');
    const empty = estimateAttributableCost({ usage: [], resource_counts: {} }, PRICE_CEILINGS);
    assert.ok(empty.ok);
    assert.equal(empty.value.estimated_cost_usd, '0.00');
  });
});

describe('estimateWithinCeiling', () => {
  it('accepts an estimate at or below the ceiling and refuses one above', () => {
    assert.equal(estimateWithinCeiling(usd('5.00'), usd('5.00')), true);
    assert.equal(estimateWithinCeiling(usd('4.99'), usd('5.00')), true);
    assert.equal(estimateWithinCeiling(usd('5.01'), usd('5.00')), false);
  });

  it('never accepts an unreadable estimate or ceiling', () => {
    assert.equal(estimateWithinCeiling(usd('x'), usd('5.00')), false);
    assert.equal(estimateWithinCeiling(usd('0.01'), usd('-5')), false);
  });
});
