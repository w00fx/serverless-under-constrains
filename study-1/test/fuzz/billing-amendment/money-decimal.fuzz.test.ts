// Exact money arithmetic of the billed-cost check (BR-RUA-047: no rounding, no conversion), against
// an independent scaled-BigInt reference: CUR cost text in any accepted form reads as the same
// amount, unreadable text is refused without throwing (A-05), and sums and comparisons are exact.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { compareMoney, isMoneyDecimal, parseCurCost, sumMoney } from '../../../src/billing-amendment/money-decimal.ts';
import type { MoneyDecimal } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const SCALE = 30;

// Value of a money decimal in units of 10^-SCALE.
function reference(amount: string): bigint {
  const [integer = '', fraction = ''] = amount.split('.');
  return BigInt(integer) * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, '0'));
}

// Reference formatter: `units` × 10^-scale as plain decimal text (trailing zeros kept, which a money
// decimal allows).
function decimalText(units: bigint, scale: number): MoneyDecimal {
  const digits = units.toString().padStart(scale + 1, '0');
  const integer = digits.slice(0, digits.length - scale);
  return (scale === 0 ? integer : `${integer}.${digits.slice(digits.length - scale)}`) as MoneyDecimal;
}

// An amount of `units` × 10^-scale written in exponent form: digits then `e-<scale>`.
const scaledAmount = fc.record({
  units: fc.bigInt({ min: 0n, max: 10n ** 20n }),
  scale: fc.integer({ min: 0, max: 10 }),
});

describe('parseCurCost (property)', () => {
  it('never throws and yields only money decimals', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('0', '1', '9', '.', 'e', 'E', '+', '-', 'x', ' '), maxLength: 70 }),
        (text) => {
          const cost = parseCurCost(text);
          assert.ok(cost === undefined || isMoneyDecimal(cost), String(cost));
        },
      ),
      fuzzParameters(),
    );
  });

  it('reads plain and exponent forms of one amount as that amount', () => {
    fc.assert(
      fc.property(scaledAmount, ({ units, scale }) => {
        const expected = units * 10n ** BigInt(SCALE - scale);
        const exponentForm = parseCurCost(`${String(units)}e-${String(scale)}`);
        assert.ok(exponentForm !== undefined);
        assert.equal(reference(exponentForm), expected);
        assert.doesNotMatch(exponentForm, /\.\d*0$/, 'converted text carries no trailing zero');
      }),
      fuzzParameters(),
    );
  });
});

describe('sumMoney and compareMoney (property)', () => {
  it('sum and compare exactly', () => {
    const money = scaledAmount.map(({ units, scale }) => decimalText(units, scale));
    fc.assert(
      fc.property(fc.array(money, { maxLength: 8 }), money, (amounts, other) => {
        const total = sumMoney(amounts);
        const expected = amounts.reduce((sum, amount) => sum + reference(amount), 0n);
        assert.equal(reference(total), expected);
        const ordering = expected === reference(other) ? 0 : expected < reference(other) ? -1 : 1;
        assert.equal(compareMoney(total, other), ordering);
      }),
      fuzzParameters(),
    );
  });
});
