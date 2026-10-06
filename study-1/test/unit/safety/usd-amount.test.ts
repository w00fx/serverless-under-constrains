// Exact USD arithmetic of the cost estimate (BR-RUA-046, D-19).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { USD_SCALE_DIGITS, centsCeiling, exactUsd, scaledUsd } from '../../../src/safety/usd-amount.ts';

describe('scaledUsd', () => {
  it('reads money decimals as counts of 10^-12 USD', () => {
    assert.equal(USD_SCALE_DIGITS, 12);
    assert.equal(scaledUsd('5.00'), 5_000_000_000_000n);
    assert.equal(scaledUsd('0.0000166667'), 16_666_700n);
    assert.equal(scaledUsd('0'), 0n);
    assert.equal(scaledUsd('12'), 12_000_000_000_000n);
    assert.equal(scaledUsd('0.000000000001'), 1n);
  });

  it('refuses text that is not a nonnegative money decimal', () => {
    for (const text of ['-1', '1.', '.5', '01', '1e3', '', ' 1', '1,00', 'NaN']) {
      assert.equal(scaledUsd(text), undefined, text);
    }
  });

  it('refuses more fraction digits than the scale holds', () => {
    assert.equal(scaledUsd('0.0000000000001'), undefined);
  });
});

describe('centsCeiling', () => {
  it('rounds up to whole cents with two fraction digits', () => {
    assert.equal(centsCeiling(0n), '0.00');
    assert.equal(centsCeiling(1n), '0.01');
    assert.equal(centsCeiling(10_000_000_000n), '0.01');
    assert.equal(centsCeiling(10_000_000_001n), '0.02');
    assert.equal(centsCeiling(5_000_000_000_000n), '5.00');
    assert.equal(centsCeiling(274_312_800_000n), '0.28');
    assert.equal(centsCeiling(12_345_000_000_000n), '12.35');
  });
});

describe('exactUsd', () => {
  it('renders exactly without trailing fraction zeros', () => {
    assert.equal(exactUsd(16_666_700n), '0.0000166667');
    assert.equal(exactUsd(5_000_000_000_000n), '5');
    assert.equal(exactUsd(0n), '0');
    assert.equal(exactUsd(1n), '0.000000000001');
    assert.equal(exactUsd(1_500_000_000_000n), '1.5');
  });
});
