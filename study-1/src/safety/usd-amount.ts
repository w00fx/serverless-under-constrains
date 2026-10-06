// Exact USD arithmetic for the admission cost estimate (BR-RUA-046, D-19). Amounts are
// `MoneyDecimal` strings (`_defs` `money_decimal`) held as BigInt counts of 10^-12 USD, so a
// per-unit price such as 0.0000166667 multiplies exactly and nothing is rounded through a double.
// The estimate is rounded up to whole cents: a conservative estimate never rounds down.

import type { MoneyDecimal } from '../record-contract/primitives.ts';

/** Decimal places of the internal scale; per-unit AWS prices use at most ten. */
export const USD_SCALE_DIGITS = 12;

const MONEY_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const SCALE = 10n ** BigInt(USD_SCALE_DIGITS);
const SCALE_PER_CENT = SCALE / 100n;

/**
 * Reads a `MoneyDecimal` as a count of 10^-12 USD, or `undefined` when the text is not a money
 * decimal or has more fraction digits than the scale holds.
 *
 * @example
 * scaledUsd('5.00'); // 5000000000000n
 * scaledUsd('-1'); // undefined
 */
export function scaledUsd(text: string): bigint | undefined {
  if (!MONEY_DECIMAL_PATTERN.test(text)) {
    return undefined;
  }
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > USD_SCALE_DIGITS) {
    return undefined;
  }
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(USD_SCALE_DIGITS, '0'));
}

/**
 * Renders a scaled amount rounded up to whole cents, with exactly two fraction digits.
 *
 * @example
 * centsCeiling(1n); // '0.01'
 * centsCeiling(5000000000000n); // '5.00'
 */
export function centsCeiling(scaled: bigint): MoneyDecimal {
  const cents = (scaled + SCALE_PER_CENT - 1n) / SCALE_PER_CENT;
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${fraction}` as MoneyDecimal;
}

/**
 * Renders a scaled amount exactly, without trailing fraction zeros.
 *
 * @example
 * exactUsd(16666700n); // '0.0000166667'
 */
export function exactUsd(scaled: bigint): MoneyDecimal {
  const whole = scaled / SCALE;
  const fraction = (scaled % SCALE).toString().padStart(USD_SCALE_DIGITS, '0').replace(/0+$/, '');
  return (fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`) as MoneyDecimal;
}
