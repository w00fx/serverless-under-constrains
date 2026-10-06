// Exact USD arithmetic (BR-RUA-047: no conversion, no rounding): CUR cost text read exactly or
// refused, sums and comparisons on scaled integers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COST_EXPONENT_MAX,
  COST_TEXT_MAX_LENGTH,
  compareMoney,
  isMoneyDecimal,
  parseCurCost,
  sumMoney,
} from '../../../src/billing-amendment/money-decimal.ts';
import type { MoneyDecimal } from '../../../src/record-contract/primitives.ts';

const money = (text: string): MoneyDecimal => text as MoneyDecimal;

describe('isMoneyDecimal', () => {
  it('accepts nonnegative decimals without leading zeros', () => {
    for (const text of ['0', '5', '5.00', '0.0000125', '12345678901234567890.1']) {
      assert.equal(isMoneyDecimal(text), true, text);
    }
  });

  it('refuses everything else', () => {
    for (const value of ['', '-1', '01', '1.', '.5', '1e3', ' 1', '1 ', 'NaN', 'Infinity', 5, null]) {
      assert.equal(isMoneyDecimal(value), false, String(value));
    }
  });
});

describe('parseCurCost', () => {
  it('keeps a money decimal verbatim', () => {
    assert.equal(parseCurCost('3.10'), '3.10');
    assert.equal(parseCurCost('0'), '0');
  });

  it('converts exponent, leading-zero and bare-fraction forms exactly', () => {
    assert.equal(parseCurCost('1.25E-5'), '0.0000125');
    assert.equal(parseCurCost('1.25e-5'), '0.0000125');
    assert.equal(parseCurCost('1.5e2'), '150');
    assert.equal(parseCurCost('1.5E+2'), '150');
    assert.equal(parseCurCost('12e-1'), '1.2');
    assert.equal(parseCurCost('007.50'), '7.5');
    assert.equal(parseCurCost('.5'), '0.5');
    assert.equal(parseCurCost('5.'), '5');
    assert.equal(parseCurCost('0.000e0'), '0');
    assert.equal(parseCurCost('00'), '0');
    assert.equal(parseCurCost('1.000e-3'), '0.001');
  });

  it('accepts the exponent and length bounds exactly', () => {
    assert.equal(parseCurCost(`1e${String(COST_EXPONENT_MAX)}`), `1${'0'.repeat(COST_EXPONENT_MAX)}`);
    assert.equal(parseCurCost(`1e-${String(COST_EXPONENT_MAX)}`), `0.${'0'.repeat(COST_EXPONENT_MAX - 1)}1`);
    assert.equal(parseCurCost('1'.repeat(COST_TEXT_MAX_LENGTH)), '1'.repeat(COST_TEXT_MAX_LENGTH));
  });

  it('refuses negative, non-finite, malformed and oversized text (A-05)', () => {
    const refused = [
      '',
      '-0.01',
      '+1',
      'NaN',
      'Infinity',
      '1e400',
      `1e${String(COST_EXPONENT_MAX + 1)}`,
      `1e-${String(COST_EXPONENT_MAX + 1)}`,
      '1'.repeat(COST_TEXT_MAX_LENGTH + 1),
      `0.${'0'.repeat(COST_TEXT_MAX_LENGTH)}`,
      '.',
      'e5',
      '.e5',
      '1e',
      '1,5',
      ' 1',
      '0x10',
    ];
    for (const text of refused) {
      assert.equal(parseCurCost(text), undefined, text);
    }
  });
});

describe('sumMoney and compareMoney', () => {
  it('sums exactly across different numbers of fractional digits', () => {
    assert.equal(sumMoney([money('0.0000166667'), money('1.25')]), '1.2500166667');
    assert.equal(sumMoney([money('3.10'), money('1.95')]), '5.05');
    assert.equal(sumMoney([money('0.1'), money('0.2')]), '0.3');
    assert.equal(sumMoney([money('9007199254740993'), money('1')]), '9007199254740994');
    assert.equal(sumMoney([money('2'), money('3')]), '5');
    assert.equal(sumMoney([]), '0');
  });

  it('compares numerically, whatever the trailing zeros', () => {
    assert.equal(compareMoney(money('5.00'), money('5')), 0);
    assert.equal(compareMoney(money('5.05'), money('5.00')), 1);
    assert.equal(compareMoney(money('4.9999999999'), money('5')), -1);
    assert.equal(compareMoney(money('10'), money('9.99')), 1);
  });

  it('throws with the offending value on a non-money operand', () => {
    assert.throws(() => sumMoney([money('-1')]), {
      name: 'RangeError',
      message: 'money amount "-1" is not a money decimal; expected ^(0|[1-9][0-9]*)(\\.[0-9]+)?$',
    });
    assert.throws(() => compareMoney(money('1'), money('1e3')), RangeError);
  });
});
