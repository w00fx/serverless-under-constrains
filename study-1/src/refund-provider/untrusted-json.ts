// Total, bounded handling of the untrusted values a provider invocation carries (BR-RUA-018,
// AC-RUA-042, testing rule 6). The Lambda runtime JSON-parses the Invoke bytes before the
// handler runs, so a payload can hold values that canonical JSON refuses or that recursion
// cannot walk: `1e400` parses to Infinity, and nesting is limited only by the 6 MB payload
// (WP-07 review round 1: such calls were neither received nor rejected).
//
// The kernel owns JSON walking and rendering (Owner amendment A-05, policy 1), so this module
// only adapts the kernel helpers to the provider's needs: the bounded describers of rejection and
// fault details, and the request digest. It keeps no walker or renderer of its own.

import { sha256Hex } from '../record-contract/digests.ts';
import type { JsonTextStyle } from '../record-contract/json-text.ts';
import { jsonTextPieces } from '../record-contract/json-text.ts';
import { boundedJsonText, describeJson } from '../record-contract/json-value.ts';
import type { JsonValue, Sha256Hex } from '../record-contract/primitives.ts';
import type { WriteOutcome } from '../durable-store/item-store-port.ts';

const UTF8 = new TextEncoder();

// The kernel's canonical form (sorted keys, JSON.stringify spelling) with one extension: a
// non-finite number, which only an out-of-range literal such as `1e400` produces, is written as
// the bare token `Infinity` or `-Infinity`. Canonical JSON never contains such a token, so the
// digest stays total without colliding with any finite payload. Parsed JSON holds only plain
// objects, so every object is walked.
const DIGEST_STYLE: JsonTextStyle = {
  sortKeys: true,
  leafText: digestLeafText,
  keyText: (key) => JSON.stringify(key),
  isWalkedObject: () => true,
};

/**
 * Describes an untrusted value for a rejection or fault detail with the kernel's `describeJson`:
 * its JSON type and at most `QUOTED_JSON_LIMIT` characters of its JSON text. A non-finite number
 * at the top is named (`number Infinity`), because JSON text would print it as `null`; one nested
 * deeper reads as JSON.stringify writes it. The result is always well formed, so it can be stored
 * as UTF-8. Never throws, at any depth.
 *
 * @example
 * describeUntrusted([1]); // 'array [1]'
 * describeUntrusted(Number.POSITIVE_INFINITY); // 'number Infinity'
 * describeUntrusted(undefined); // 'absent'
 */
export function describeUntrusted(value: JsonValue | undefined): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return `number ${String(value)}`;
  }
  return describeJson(value).toWellFormed();
}

/**
 * The bounded JSON text of `describeUntrusted` without the type name (the kernel's
 * `boundedJsonText`, made well formed), for a value whose type the message already states.
 *
 * @example
 * excerptUntrusted('ABC'); // '"ABC"'
 * excerptUntrusted('x'.repeat(500)).endsWith('…[truncated]'); // true
 */
export function excerptUntrusted(value: JsonValue): string {
  return boundedJsonText(value).toWellFormed();
}

/**
 * Describes a store write outcome for a fault or failure detail. A failed condition carries the
 * item the store returned, which is untrusted store content (A-05), so it is rendered bounded.
 *
 * @example
 * describeWriteOutcome({ kind: 'ambiguous', code: 'TimeoutError' }); // '{"kind":"ambiguous","code":"TimeoutError"}'
 */
export function describeWriteOutcome(outcome: WriteOutcome): string {
  return excerptUntrusted(outcome);
}

/**
 * The `raw_request_sha256` of a received call: lowercase SHA-256 of the UTF-8 canonical JSON of
 * the payload as the runtime parsed it (sorted keys, no whitespace), written by the kernel's
 * iterative walker. For every finite payload the bytes equal `canonicalJson(raw)`; a non-finite
 * number is written `Infinity` or `-Infinity`.
 *
 * @example
 * requestDigest({ b: 1, a: 'x' }) === sha256Hex(new TextEncoder().encode('{"a":"x","b":1}')); // true
 */
export function requestDigest(raw: JsonValue): Sha256Hex {
  return sha256Hex(UTF8.encode([...jsonTextPieces(raw, DIGEST_STYLE)].join('')));
}

function digestLeafText(value: unknown): string {
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value);
}
