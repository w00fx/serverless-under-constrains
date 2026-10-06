// Time for BR-RUA-047's "contained usage interval" (design §8.17). CUR 2.0 writes usage and billing
// period instants as UTC `YYYY-MM-DDTHH:mm:ssZ`, start inclusive and end exclusive, at hourly
// granularity at best; the attribution window is therefore the run's mutation interval widened to
// whole hours, `[floor_hour(first_mutation_at), ceil_hour(cleanup_terminal_at))`. That widening is
// the design default flagged as spec finding F13; a line that straddles the window is never split.

import { formatUtcMillis, isUtcMillis } from '../record-contract/timestamps.ts';
import type { UtcMillis } from '../record-contract/primitives.ts';

/** A half-open interval `[start, end)` of serialized UTC instants. */
export interface UsageInterval {
  readonly start: UtcMillis;
  readonly end: UtcMillis;
}

const HOUR_MS = 3_600_000;
const CUR_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Reads a CUR timestamp cell (`YYYY-MM-DDTHH:mm:ssZ`, or the millisecond form) as `UtcMillis`, or
 * `undefined` when it is not an existing UTC instant in either form.
 *
 * @example
 * parseCurTimestamp('2026-10-05T10:00:00Z'); // '2026-10-05T10:00:00.000Z'
 * parseCurTimestamp('2026-10-05 10:00:00'); // undefined
 */
export function parseCurTimestamp(text: string): UtcMillis | undefined {
  const millis = CUR_SECONDS_PATTERN.test(text) ? `${text.slice(0, -1)}.000Z` : text;
  return isUtcMillis(millis) ? millis : undefined;
}

/**
 * Reads a CUR usage interval; `undefined` when either end is unreadable or the end does not follow
 * the start.
 *
 * @example
 * parseCurInterval('2026-10-05T10:00:00Z', '2026-10-05T11:00:00Z'); // { start: '…T10:00:00.000Z', end: '…T11:00:00.000Z' }
 */
export function parseCurInterval(startText: string, endText: string): UsageInterval | undefined {
  const start = parseCurTimestamp(startText);
  const end = parseCurTimestamp(endText);
  if (start === undefined || end === undefined || Date.parse(end) <= Date.parse(start)) {
    return undefined;
  }
  return { start, end };
}

/**
 * The attribution window of design §8.17: the hour that contains the first mutation through the end
 * of the hour in which cleanup became terminal (an instant already on the hour stays there).
 *
 * @example
 * attributionWindow('2026-10-05T10:17:03.120Z' as UtcMillis, '2026-10-05T11:02:00.000Z' as UtcMillis);
 * // { start: '2026-10-05T10:00:00.000Z', end: '2026-10-05T12:00:00.000Z' }
 */
export function attributionWindow(firstMutationAt: UtcMillis, cleanupTerminalAt: UtcMillis): UsageInterval {
  const start = Math.floor(Date.parse(firstMutationAt) / HOUR_MS) * HOUR_MS;
  const end = Math.ceil(Date.parse(cleanupTerminalAt) / HOUR_MS) * HOUR_MS;
  return { start: formatUtcMillis(new Date(start)), end: formatUtcMillis(new Date(end)) };
}

/**
 * Tells whether `inner` lies entirely inside `outer` (both half-open).
 *
 * @example
 * isContained({ start: '…T10:00:00.000Z', end: '…T11:00:00.000Z' }, window); // true when window covers 10:00-11:00
 */
export function isContained(inner: UsageInterval, outer: UsageInterval): boolean {
  return Date.parse(inner.start) >= Date.parse(outer.start) && Date.parse(inner.end) <= Date.parse(outer.end);
}

/**
 * Tells whether two half-open intervals share no instant.
 *
 * @example
 * isDisjoint({ start: '…T09:00:00.000Z', end: '…T10:00:00.000Z' }, { start: '…T10:00:00.000Z', end: '…T11:00:00.000Z' }); // true
 */
export function isDisjoint(a: UsageInterval, b: UsageInterval): boolean {
  return Date.parse(a.end) <= Date.parse(b.start) || Date.parse(b.end) <= Date.parse(a.start);
}
