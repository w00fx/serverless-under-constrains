// Total readers of untrusted service output (Owner amendment A-05). SQS and Lambda responses
// reach the collector as SDK objects whose members may be absent, of the wrong type, or (from a
// hostile or broken endpoint) inherited, non-finite or out of range. These helpers read only own
// members, never throw, and return `undefined` for anything outside the expected shape, so each
// mapper turns a malformed member into a recorded failure instead of a crash or a bad record.

import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonValue, Result, UtcMillis } from '../record-contract/primitives.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { CollectorReadFailure } from './collected-records.ts';

/** The first and last instants BR-RUA-033 timestamps can spell (years 0000-9999). */
// Date.UTC maps years 0-99 to 1900-1999, so both bounds are parsed from their ISO spelling.
const MIN_INSTANT_MS = Date.parse('0000-01-01T00:00:00.000Z');
const MAX_INSTANT_MS = Date.parse('9999-12-31T23:59:59.999Z');
const DIGITS = /^(0|[1-9][0-9]*)$/;

/**
 * An own member of an object-like value; `undefined` for a non-object, an absent member or an
 * inherited one (a prototype member is never data).
 *
 * @example
 * ownValue({ Body: 'x' }, 'Body'); // 'x'
 * ownValue({}, 'toString'); // undefined
 */
export function ownValue(holder: unknown, key: string): unknown {
  if (typeof holder !== 'object' || holder === null || !Object.hasOwn(holder, key)) {
    return undefined;
  }
  return (holder as Readonly<Record<string, unknown>>)[key];
}

/**
 * A string with at least one character, or `undefined`.
 *
 * @example
 * nonEmptyString('arn:aws:lambda:…'); // 'arn:aws:lambda:…'
 * nonEmptyString(''); // undefined
 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A safe integer of at least `minimum`, or `undefined` (NaN, Infinity and fractions are refused).
 *
 * @example
 * safeCount(2, 1); // 2
 * safeCount(Infinity, 0); // undefined
 */
export function safeCount(value: unknown, minimum: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

/**
 * A canonical decimal digit string read as a safe integer of at least `minimum`.
 *
 * @example
 * digitCount('2', 1); // 2
 * digitCount('02', 1); // undefined
 */
export function digitCount(value: unknown, minimum: number): number | undefined {
  if (typeof value !== 'string' || !DIGITS.test(value)) {
    return undefined;
  }
  return safeCount(Number(value), minimum);
}

/**
 * The UTC millisecond spelling of an SDK `Date`, or `undefined` for anything that is not a valid
 * instant within years 0000-9999.
 *
 * @example
 * instantOfDate(new Date(0)); // '1970-01-01T00:00:00.000Z'
 */
export function instantOfDate(value: unknown): UtcMillis | undefined {
  if (!(value instanceof Date)) {
    return undefined;
  }
  return instantOfMillis(value.getTime());
}

/**
 * The UTC millisecond spelling of an SQS epoch-millisecond attribute (`SentTimestamp`), which is
 * lossless (dlq_snapshot schema).
 *
 * @example
 * instantOfEpochText('1791202505000'); // '2026-10-05T12:15:05.000Z'
 */
export function instantOfEpochText(value: unknown): UtcMillis | undefined {
  const millis = digitCount(value, 0);
  return millis === undefined ? undefined : instantOfMillis(millis);
}

/**
 * A bounded rendering of an untrusted value for a reason detail; never throws.
 *
 * @example
 * quoted('x'); // '"x"'
 * quoted(undefined); // 'absent'
 */
export function quoted(value: unknown): string {
  if (value === undefined) {
    return 'absent';
  }
  if (value instanceof Date) {
    return `a Date of ${String(value.getTime())} ms`;
  }
  // boundedJsonText walks any value iteratively and stops at its limit (A-05 policy 1).
  return boundedJsonText(value as JsonValue);
}

/**
 * Runs one SDK call and turns a thrown error into a failure value named by the error's `name`
 * (`ThrottlingException`, `QueueDoesNotExist`, …), so every port reports failure without throwing.
 *
 * @example
 * const output = await settleSdkCall(() => client.send(new GetQueueAttributesCommand(input)));
 */
export async function settleSdkCall<T>(call: () => Promise<T>): Promise<Result<T, CollectorReadFailure>> {
  try {
    return ok(await call());
  } catch (error: unknown) {
    // An Error's name lives on its prototype unless the SDK set its own (service exceptions do).
    const name = error instanceof Error ? error.name : ownValue(error, 'name');
    return err({ code: nonEmptyString(name) ?? 'UnknownError' });
  }
}

function instantOfMillis(millis: number): UtcMillis | undefined {
  if (!Number.isInteger(millis) || millis < MIN_INSTANT_MS || millis > MAX_INSTANT_MS) {
    return undefined;
  }
  return formatUtcMillis(new Date(millis));
}
