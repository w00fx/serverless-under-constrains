// Bounded renderings of untrusted values for structured reasons (design §5.2: a reason's detail
// "includes the offending value and the expected shape"). A provider payload, a response header
// or a thrown value is attacker-shaped, so two things must never happen when one is rendered
// (WP-06 review round 1):
// - a recursive `JSON.stringify` of a deeply nested value overflows the call stack, which made
//   the response parser throw after the dispatch boundary instead of classifying the payload as
//   MALFORMED_RESPONSE (design §9.9);
// - a whole value copied into `attempt_outcome_recorded.failure.detail` can push the event past
//   the 400 KB DynamoDB item limit (aws-semantics.md), so the outcome would never be stored.
// Every rendering here is non-recursive and at most OFFENDING_VALUE_PREVIEW_CHARS characters
// plus a fixed suffix that names the original length.

import type { JsonValue } from '../record-contract/primitives.ts';

/** The most characters of an untrusted value a structured reason repeats. */
export const OFFENDING_VALUE_PREVIEW_CHARS = 256;

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

/**
 * `text` itself when it fits the preview budget; otherwise its first
 * OFFENDING_VALUE_PREVIEW_CHARS characters (one fewer when the cut would split a surrogate pair)
 * followed by `... (<length> chars)`.
 *
 * @example
 * boundedText('X'.repeat(300)); // 'XXX…X... (300 chars)' with 256 X
 */
export function boundedText(text: string): string {
  if (text.length <= OFFENDING_VALUE_PREVIEW_CHARS) {
    return text;
  }
  const lastKept = text.charCodeAt(OFFENDING_VALUE_PREVIEW_CHARS - 1);
  const splitsPair = lastKept >= HIGH_SURROGATE_MIN && lastKept <= HIGH_SURROGATE_MAX;
  const end = splitsPair ? OFFENDING_VALUE_PREVIEW_CHARS - 1 : OFFENDING_VALUE_PREVIEW_CHARS;
  return `${text.slice(0, end)}... (${String(text.length)} chars)`;
}

/**
 * A bounded, non-recursive rendering of a JSON value (or of an absent property): scalars as
 * their JSON text, containers by kind and size only, so any nesting depth is safe.
 *
 * @example
 * describeJsonValue('TOO_LATE'); // '"TOO_LATE"'
 * describeJsonValue([[[]]]); // 'an array of length 1'
 * describeJsonValue(undefined); // 'undefined'
 */
export function describeJsonValue(value: JsonValue | undefined): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (Array.isArray(value)) {
    return `an array of length ${String(value.length)}`;
  }
  if (typeof value === 'object' && value !== null) {
    return `an object with ${String(Object.keys(value).length)} key(s)`;
  }
  return boundedText(JSON.stringify(value));
}
