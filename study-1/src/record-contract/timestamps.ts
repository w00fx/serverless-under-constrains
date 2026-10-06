// UTC millisecond timestamps (BR-RUA-033). The pattern alone accepts impossible dates such
// as 2026-02-30, so parsing also requires a Date round trip (toolchain research §5).

import { boundedJsonText } from './json-value.ts';
import type { Result, StructuredReason, UtcMillis } from './primitives.ts';

export const UTC_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Tells whether a value is an existing UTC instant written as `YYYY-MM-DDTHH:mm:ss.SSSZ`.
 *
 * @example
 * isUtcMillis('2026-10-05T12:00:00.000Z'); // true
 * isUtcMillis('2026-02-30T00:00:00.000Z'); // false (no such day)
 */
export function isUtcMillis(value: unknown): value is UtcMillis {
  if (typeof value !== 'string' || !UTC_MILLIS_PATTERN.test(value)) {
    return false;
  }
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

/**
 * Formats an instant with exactly millisecond precision in UTC.
 *
 * @example
 * formatUtcMillis(new Date(Date.UTC(2026, 9, 5))); // '2026-10-05T00:00:00.000Z'
 */
export function formatUtcMillis(instant: Date): UtcMillis {
  const millis = instant.getTime();
  const text = Number.isNaN(millis) ? 'Invalid Date' : instant.toISOString();
  if (!isUtcMillis(text)) {
    throw new RangeError(
      `cannot format ${boundedJsonText(text)} as UTC millis; expected a valid instant in years 0000-9999 (YYYY-MM-DDTHH:mm:ss.SSSZ)`,
    );
  }
  return text;
}

/**
 * Parses a serialized timestamp, returning a structured reason on any deviation; the reason
 * quotes the untrusted value bounded (A-05 policy 1).
 *
 * @example
 * const parsed = parseUtcMillis(record.occurred_at, 'occurred_at');
 */
export function parseUtcMillis(value: string, subject = 'utc_millis'): Result<UtcMillis, StructuredReason> {
  if (isUtcMillis(value)) {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: {
      code: 'INVALID_UTC_MILLIS',
      subject,
      detail: `got ${boundedJsonText(value)}; expected an existing UTC instant formatted YYYY-MM-DDTHH:mm:ss.SSSZ`,
    },
  };
}
