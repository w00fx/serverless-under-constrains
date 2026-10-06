// Step A14 (SAFETY, boundary ESTIMATED_COST; BR-RUA-046, OR-RUA-003..005): the planned resources
// priced at the committed ceilings stay within each kind's ceiling; an estimate above it or one
// that cannot be computed is a safety rejection.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessEstimatedCost } from '../../../src/admission/cost-check.ts';
import type { CostCheckInput } from '../../../src/admission/cost-check.ts';
import type { MoneyDecimal } from '../../../src/record-contract/primitives.ts';
import { PRICE_CEILINGS } from '../../../src/safety/price-ceilings.ts';
import { PROBE_SAFETY, RUN_SAFETY } from '../../../src/safety/safety-limits.ts';

const RUN: CostCheckInput = {
  kind: 'RUN',
  limits: RUN_SAFETY,
  treatment_poll_interval_ms: 250,
  prices: PRICE_CEILINGS,
};

describe('assessEstimatedCost (A14)', () => {
  it('admits every kind at its OR-RUA estimate', () => {
    const cases = [
      [RUN, '0.28'],
      [{ ...RUN, kind: 'TRANSPORT_PROBE', limits: PROBE_SAFETY }, '0.03'],
      [{ ...RUN, kind: 'VARIANT_VALIDATION', variant_id: 'durable' }, '0.22'],
      [{ ...RUN, kind: 'VARIANT_VALIDATION', variant_id: 'conventional' }, '0.18'],
    ] as const;
    for (const [input, estimate] of cases) {
      const verdict = assessEstimatedCost(input);
      assert.ok(verdict.passed, JSON.stringify(verdict));
      assert.equal(verdict.value.estimated_cost_usd, estimate);
      assert.deepEqual(verdict.statement, {
        subject: 'estimated_cost',
        expected: { boundary: 'ESTIMATED_COST', ceiling_usd: input.limits.ceiling_usd },
        observed: { estimated_cost_usd: estimate },
      });
    }
  });

  it('records the planned resource counts', () => {
    const verdict = assessEstimatedCost(RUN);
    assert.ok(verdict.passed);
    assert.deepEqual(verdict.value.resource_counts, { functions: 4, tables: 5, fifo_queues: 4, standard_queues: 1 });
  });

  it('refuses an estimate above the ceiling', () => {
    const verdict = assessEstimatedCost({ ...RUN, limits: { ...RUN_SAFETY, ceiling_usd: '0.27' as MoneyDecimal } });
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'SAFETY');
    assert.deepEqual(verdict.reasons, [
      {
        code: 'ESTIMATED_COST_ABOVE_CEILING',
        subject: 'BR-RUA-046',
        detail: 'the estimated attributable cost is USD 0.28; expected at most the ceiling USD 0.27',
      },
    ]);
  });

  it('refuses an estimate that cannot be priced, keeping every pricing reason', () => {
    const verdict = assessEstimatedCost({ ...RUN, prices: [] });
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'SAFETY');
    assert.ok(verdict.reasons.length > 1);
    assert.ok(verdict.reasons.every((reason) => reason.code === 'PRICE_CEILING_MISSING'));
    assert.equal(verdict.statement.observed, undefined);
  });
});
