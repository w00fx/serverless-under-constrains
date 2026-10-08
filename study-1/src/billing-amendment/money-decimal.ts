// Exact USD arithmetic for the billed-cost check (BR-RUA-047, design §8.17): billing amounts are
// `MoneyDecimal` strings (`_defs` `money_decimal`), summed and compared on scaled BigInt so no
// amount is ever rounded through a double. CUR 2.0 types `line_item_unblended_cost` as a double,
// so an export may print it in exponent form; `parseCurCost` converts that text exactly, within a
// fixed bound, and refuses everything else (negative, non-finite or oversized text) instead of
// guessing (A-05: a non-finite number is malformed input, never a value).

import { boundedJsonText } from '../record-contract/json-value.ts';
import type { MoneyDecimal } from '../record-contract/primitives.ts';

/** `_defs.schema.json#/$defs/money_decimal`. */
export const MONEY_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** Longest cost text read from an export; anything longer is unreadable, never truncated. */
export const COST_TEXT_MAX_LENGTH = 64;
/** Largest decimal exponent magnitude accepted, so `1e999999999` can never allocate a huge string. */
export const COST_EXPONENT_MAX = 64;

const COST_TEXT_PATTERN = /^[0-9]*(\.[0-9]*)?([eE][+-]?[0-9]+)?$/;

interface ScaledAmount {
  readonly units: bigint;
  readonly scale: number;
}

/**
 * Tells whether a value is a nonnegative decimal money amount.
 *
 * @example
 * isMoneyDecimal('5.00'); // true
 * isMoneyDecimal('-1'); // false
 */
export function isMoneyDecimal(value: unknown): value is MoneyDecimal {
  return typeof value === 'string' && MONEY_DECIMAL_PATTERN.test(value);
}

/**
 * Reads a CUR cost cell exactly as a `MoneyDecimal`, or `undefined` when the text is not a
 * nonnegative finite decimal within the bounds above. Text that already is a money decimal is kept
 * verbatim, so the record shows the exported digits; any other accepted form (exponent, leading
 * zeros, a bare fraction) is converted exactly to the canonical form, with no trailing zeros.
 *
 * @example
 * parseCurCost('3.10'); // '3.10'
 * parseCurCost('1.25E-5'); // '0.0000125'
 * parseCurCost('-0.01'); // undefined (a usage charge is never negative)
 */
export function parseCurCost(text: string): MoneyDecimal | undefined {
  if (text.length > COST_TEXT_MAX_LENGTH) {
    return undefined;
  }
  if (isMoneyDecimal(text)) {
    return text;
  }
  if (!COST_TEXT_PATTERN.test(text)) {
    return undefined;
  }
  const exponentAt = text.search(/[eE]/);
  const mantissa = exponentAt === -1 ? text : text.slice(0, exponentAt);
  const exponent = exponentAt === -1 ? 0 : Number(text.slice(exponentAt + 1));
  const point = mantissa.indexOf('.');
  const integer = point === -1 ? mantissa : mantissa.slice(0, point);
  const fraction = point === -1 ? '' : mantissa.slice(point + 1);
  if (integer.length + fraction.length === 0 || Math.abs(exponent) > COST_EXPONENT_MAX) {
    return undefined;
  }
  return formatScaled({ units: BigInt(integer + fraction), scale: fraction.length - exponent });
}

/**
 * Sums money amounts exactly; the empty sum is `'0'`.
 *
 * @example
 * sumMoney(['1.25' as MoneyDecimal, '0.0000002' as MoneyDecimal]); // '1.2500002'
 */
export function sumMoney(amounts: readonly MoneyDecimal[]): MoneyDecimal {
  const scaled = amounts.map(toScaled);
  // A fold, never `Math.max(...list)`: spreading one argument per export line overflows the stack
  // from about 125,000 lines (A-05; WP-18 single-pass review).
  const scale = scaled.reduce((widest, amount) => Math.max(widest, amount.scale), 0);
  const units = scaled.reduce((total, amount) => total + rescale(amount, scale), 0n);
  return formatScaled({ units, scale });
}

/**
 * Compares two money amounts numerically, whatever their number of fractional digits.
 *
 * @example
 * compareMoney('5.00' as MoneyDecimal, '5' as MoneyDecimal); // 0
 */
export function compareMoney(a: MoneyDecimal, b: MoneyDecimal): -1 | 0 | 1 {
  const left = toScaled(a);
  const right = toScaled(b);
  const scale = Math.max(left.scale, right.scale);
  const difference = rescale(left, scale) - rescale(right, scale);
  if (difference === 0n) {
    return 0;
  }
  return difference < 0n ? -1 : 1;
}

function toScaled(amount: MoneyDecimal): ScaledAmount {
  if (!isMoneyDecimal(amount)) {
    throw new RangeError(
      `money amount ${boundedJsonText(amount)} is not a money decimal; expected ${MONEY_DECIMAL_PATTERN.source}`,
    );
  }
  const [integer = '', fraction = ''] = amount.split('.');
  return { units: BigInt(integer + fraction), scale: fraction.length };
}

function rescale(amount: ScaledAmount, scale: number): bigint {
  return amount.units * 10n ** BigInt(scale - amount.scale);
}

function formatScaled(amount: ScaledAmount): MoneyDecimal {
  if (amount.scale <= 0) {
    return (amount.units * 10n ** BigInt(-amount.scale)).toString() as MoneyDecimal;
  }
  const digits = amount.units.toString().padStart(amount.scale + 1, '0');
  const integer = digits.slice(0, digits.length - amount.scale);
  const fraction = digits.slice(digits.length - amount.scale).replace(/0+$/, '');
  return (fraction === '' ? integer : `${integer}.${fraction}`) as MoneyDecimal;
}
