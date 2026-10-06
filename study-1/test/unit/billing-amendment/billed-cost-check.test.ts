// The billed-cost check of BR-RUA-047 (design §5.3 `deriveBilledCostCheck`): `unverified` on any
// attribution reason, non-USD line, mixed currencies or incomplete period; otherwise the exact USD
// sum against the ceiling, `within_limit` at or below it and `breached` above it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveBilledCostCheck, periodReasons } from '../../../src/billing-amendment/billed-cost-check.ts';
import type { ExportBillingPeriod } from '../../../src/billing-amendment/cur-export.ts';
import type { AttributionResult } from '../../../src/billing-amendment/line-attribution.ts';
import type { UsageInterval } from '../../../src/billing-amendment/usage-window.ts';
import type { MoneyDecimal, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type {
  AttributedBillingLine,
  BillingUnverifiedReason,
} from '../../../src/record-contract/records/group-c/billing_import.ts';

const WINDOW: UsageInterval = {
  start: '2026-10-05T10:00:00.000Z' as UtcMillis,
  end: '2026-10-05T12:00:00.000Z' as UtcMillis,
};
const CEILING = '5.00' as MoneyDecimal;

function line(lineId: string, cost: string, currency = 'USD'): AttributedBillingLine {
  return {
    line_id: lineId,
    product_code: 'AWSLambda',
    operation: 'Invoke',
    resource_id: 'arn:aws:lambda:us-east-1:123456789012:function:suc-run-provider',
    usage_start: WINDOW.start,
    usage_end: WINDOW.end,
    currency,
    cost: cost as MoneyDecimal,
  };
}

function attribution(
  lines: readonly AttributedBillingLine[],
  reasons: readonly BillingUnverifiedReason[] = [],
): AttributionResult {
  return { window: WINDOW, lines_used: lines, exclusions: [], reasons };
}

const PERIOD: ExportBillingPeriod = {
  period_start: '2026-10-01T00:00:00.000Z' as UtcMillis,
  period_end: '2026-11-01T00:00:00.000Z' as UtcMillis,
  period_final: true,
};

describe('deriveBilledCostCheck compares the exact USD sum with the ceiling', () => {
  it('is within_limit below the ceiling', () => {
    assert.deepEqual(deriveBilledCostCheck(attribution([line('row:1', '4.99')]), CEILING), {
      billed_cost_check: 'within_limit',
      attributed_total_usd: '4.99',
      reasons: [],
    });
  });

  it('is within_limit exactly at the ceiling (a maximum, OR-RUA-003)', () => {
    assert.deepEqual(deriveBilledCostCheck(attribution([line('row:1', '2.50'), line('row:2', '2.5')]), CEILING), {
      billed_cost_check: 'within_limit',
      attributed_total_usd: '5',
      reasons: [],
    });
  });

  it('is breached one unit of the smallest digit above the ceiling', () => {
    assert.deepEqual(deriveBilledCostCheck(attribution([line('row:1', '5.0000000001')]), CEILING), {
      billed_cost_check: 'breached',
      attributed_total_usd: '5.0000000001',
      reasons: [],
    });
  });

  it('sums 150,000 attributed lines exactly (A-05: no argument spread per line)', () => {
    const lines = Array.from({ length: 150_000 }, (_, index) => line(`row:${String(index + 1)}`, '0.0001'));
    // 150,000 x 0.0001 = 15 > 5.00.
    assert.deepEqual(deriveBilledCostCheck(attribution(lines), CEILING), {
      billed_cost_check: 'breached',
      attributed_total_usd: '15',
      reasons: [],
    });
  });

  it('is within_limit with total 0 when nothing is attributable and nothing is missing', () => {
    assert.deepEqual(deriveBilledCostCheck(attribution([]), CEILING), {
      billed_cost_check: 'within_limit',
      attributed_total_usd: '0',
      reasons: [],
    });
  });
});

describe('deriveBilledCostCheck is unverified without a total', () => {
  it('on one non-USD line', () => {
    const check = deriveBilledCostCheck(attribution([line('row:7', '0.37', 'EUR')]), CEILING);
    assert.deepEqual(check, {
      billed_cost_check: 'unverified',
      reasons: [
        {
          code: 'NON_USD_LINE',
          subject: 'BR-RUA-047',
          detail:
            '1 line(s): row:7 (currency "EUR"); expected every attributable line in USD; no exchange-rate conversion is made',
        },
      ],
    });
  });

  it('on mixed currencies, after the non-USD reason', () => {
    const check = deriveBilledCostCheck(
      attribution([line('row:1', '1', 'USD'), line('row:2', '1', 'BRL'), line('row:3', '1', 'EUR')]),
      CEILING,
    );
    assert.equal(check.billed_cost_check, 'unverified');
    assert.deepEqual(
      check.reasons.map((reason) => reason.detail),
      [
        '2 line(s): row:2 (currency "BRL"), row:3 (currency "EUR"); expected every attributable line in USD; no exchange-rate conversion is made',
        'attributable lines use BRL, EUR, USD; expected one currency across attributable lines; no conversion is made',
      ],
    );
  });

  it('on attribution reasons, even when the USD lines are below the ceiling', () => {
    const shared: BillingUnverifiedReason = { code: 'SHARED_OR_UNOWNED_CHARGE', subject: 'BR-RUA-047', detail: 'd2' };
    const incomplete: BillingUnverifiedReason = { code: 'INCOMPLETE_ATTRIBUTION', subject: 'BR-RUA-047', detail: 'd1' };
    const check = deriveBilledCostCheck(attribution([line('row:1', '0.01')], [shared, incomplete]), CEILING);
    assert.deepEqual(check, { billed_cost_check: 'unverified', reasons: [incomplete, shared] });
  });

  it('orders reasons from every source by catalogue code order', () => {
    const period: BillingUnverifiedReason = { code: 'INCOMPLETE_PERIOD', subject: 'BR-RUA-047', detail: 'p' };
    const check = deriveBilledCostCheck(
      attribution([line('row:1', '1', 'EUR'), line('row:2', '1')], [period]),
      CEILING,
    );
    assert.deepEqual(
      check.reasons.map((reason) => reason.code),
      ['NON_USD_LINE', 'MIXED_CURRENCY', 'INCOMPLETE_PERIOD'],
    );
  });
});

describe('periodReasons', () => {
  it('is empty for a final period that contains the window', () => {
    assert.deepEqual(periodReasons(PERIOD, WINDOW), []);
  });

  it('reports a period that is not final', () => {
    assert.deepEqual(periodReasons({ ...PERIOD, period_final: false }, WINDOW), [
      {
        code: 'INCOMPLETE_PERIOD',
        subject: 'BR-RUA-047',
        detail:
          'billing period 2026-10-01T00:00:00.000Z to 2026-11-01T00:00:00.000Z is not final (blank bill_invoice_id); expected a final billing period that contains the attribution window',
      },
    ]);
  });

  it('reports a window outside the period, together with a non-final period in one reason', () => {
    const window = { start: '2026-10-31T23:00:00.000Z' as UtcMillis, end: '2026-11-01T01:00:00.000Z' as UtcMillis };
    assert.deepEqual(
      periodReasons({ ...PERIOD, period_final: false }, window).map((reason) => reason.detail),
      [
        'billing period 2026-10-01T00:00:00.000Z to 2026-11-01T00:00:00.000Z is not final (blank bill_invoice_id); ' +
          'attribution window 2026-10-31T23:00:00.000Z to 2026-11-01T01:00:00.000Z is not inside billing period ' +
          '2026-10-01T00:00:00.000Z to 2026-11-01T00:00:00.000Z; expected a final billing period that contains the attribution window',
      ],
    );
    assert.equal(periodReasons(PERIOD, window).length, 1);
  });
});
