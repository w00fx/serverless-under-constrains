// Exact integer arithmetic for serialized aggregates (BR-RUA-033): individual amounts are
// safe-integer JSON numbers, aggregates and elapsed nanoseconds are canonical base-10 strings.
// All arithmetic runs on BigInt so no aggregate is ever rounded through a double.

import { boundedJsonText } from './json-value.ts';
import type { DecimalString, SignedDecimalString, UtcMillis } from './primitives.ts';
import { isUtcMillis } from './timestamps.ts';

export const DECIMAL_STRING_PATTERN = /^(0|[1-9][0-9]*)$/;
export const SIGNED_DECIMAL_STRING_PATTERN = /^(0|-?[1-9][0-9]*)$/;

/**
 * Tells whether a value is a nonnegative canonical base-10 integer string.
 *
 * @example
 * isDecimalString('20000'); // true
 * isDecimalString('020000'); // false (leading zero)
 */
export function isDecimalString(value: unknown): value is DecimalString {
  return typeof value === 'string' && DECIMAL_STRING_PATTERN.test(value);
}

/**
 * Sums minor-unit amounts exactly. Each amount must be a nonnegative safe integer.
 *
 * @example
 * sumMinorUnits([10000, 10000]); // '20000'
 */
export function sumMinorUnits(amounts: readonly number[]): DecimalString {
  let total = 0n;
  for (const amount of amounts) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new RangeError(`amount ${String(amount)} is not a nonnegative safe integer; expected 0..9007199254740991`);
    }
    total += BigInt(amount);
  }
  return total.toString() as DecimalString;
}

/**
 * Compares two decimal strings numerically.
 *
 * @example
 * compareDecimal('20000' as DecimalString, '10000' as DecimalString); // 1
 */
export function compareDecimal(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  const left = toBigInt(a);
  const right = toBigInt(b);
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Renders source-local monotonic elapsed time. Absolute monotonic readings are never
 * serialized; only this nonnegative difference is.
 *
 * @example
 * elapsedNs(1_000n, 3_000_001_000n); // '3000000000'
 */
export function elapsedNs(origin: bigint, now: bigint): DecimalString {
  if (now < origin) {
    throw new RangeError(
      `monotonic reading ${now.toString()} precedes origin ${origin.toString()}; expected now >= origin`,
    );
  }
  return (now - origin).toString() as DecimalString;
}

/**
 * Signed difference `later - earlier` in milliseconds between two serialized UTC instants.
 *
 * @example
 * signedDifferenceMs('2026-10-05T00:00:02.000Z' as UtcMillis, '2026-10-05T00:00:03.000Z' as UtcMillis); // '-1000'
 */
export function signedDifferenceMs(later: UtcMillis, earlier: UtcMillis): SignedDecimalString {
  const difference = BigInt(toEpochMillis(later)) - BigInt(toEpochMillis(earlier));
  return difference.toString() as SignedDecimalString;
}

function toBigInt(value: DecimalString): bigint {
  if (!isDecimalString(value)) {
    throw new RangeError(
      `${boundedJsonText(value)} is not a decimal string; expected ${DECIMAL_STRING_PATTERN.source}`,
    );
  }
  return BigInt(value);
}

function toEpochMillis(value: UtcMillis): number {
  if (!isUtcMillis(value)) {
    throw new RangeError(`${boundedJsonText(value)} is not a UTC millis timestamp; expected YYYY-MM-DDTHH:mm:ss.SSSZ`);
  }
  return Date.parse(value);
}
