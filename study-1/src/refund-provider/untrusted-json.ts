// Total, bounded handling of the untrusted values a provider invocation carries (BR-RUA-018,
// AC-RUA-042, testing rule 6). The Lambda runtime JSON-parses the Invoke bytes before the
// handler runs, so a payload can hold values that canonical JSON refuses or that recursion
// cannot walk: `1e400` parses to Infinity, and nesting is limited only by the 6 MB payload
// (WP-07 review round 1: `canonicalJson` threw TypeError on Infinity and RangeError at a few
// thousand levels, and `describeJson` overflowed the stack, so such calls were neither
// received nor rejected). Both functions here walk the value with an explicit stack, never
// throw on a parsed value, and the describer bounds what a rejection detail echoes.

import { sha256Hex } from '../record-contract/digests.ts';
import type { JsonObject, JsonValue, Sha256Hex } from '../record-contract/primitives.ts';

/** The most UTF-16 code units of a value's serialization that a rejection detail echoes. */
export const DESCRIBED_VALUE_MAX_CHARS = 120;
/** Appended to an echoed serialization that was cut at the bound. */
export const TRUNCATION_MARKER = '… (truncated)';

/** How the walk serializes: key order, and how much of each string and key it keeps. */
interface TokenLayout {
  readonly sortKeys: boolean;
  readonly maxStringChars: number;
}

/** One member of a container: its rendered key label (objects only) and its value. */
type Member = readonly [string | undefined, JsonValue];

type WalkFrame =
  { readonly kind: 'text'; readonly text: string } | { readonly kind: 'value'; readonly value: JsonValue };

const DIGEST_LAYOUT: TokenLayout = { sortKeys: true, maxStringChars: Number.POSITIVE_INFINITY };
const DESCRIBE_LAYOUT: TokenLayout = { sortKeys: false, maxStringChars: DESCRIBED_VALUE_MAX_CHARS };
const UTF8 = new TextEncoder();

/**
 * Describes an untrusted value for a rejection or fault detail: its JSON type and a bounded
 * serialization in member order. Non-finite numbers read as `Infinity`, `-Infinity` or `NaN`
 * (JSON.stringify would print `null`), and anything longer than
 * `DESCRIBED_VALUE_MAX_CHARS` UTF-16 code units is cut and marked. Never throws, at any depth.
 *
 * @example
 * describeUntrusted([1]); // 'array [1]'
 * describeUntrusted(Number.POSITIVE_INFINITY); // 'number Infinity'
 * describeUntrusted(undefined); // 'absent'
 */
export function describeUntrusted(value: JsonValue | undefined): string {
  if (value === undefined) {
    return 'absent';
  }
  return `${jsonTypeName(value)} ${excerptUntrusted(value)}`;
}

/**
 * The bounded serialization of `describeUntrusted` without the type name, for a value whose
 * type the message already states (such as a string identity).
 *
 * @example
 * excerptUntrusted('ABC'); // '"ABC"'
 * excerptUntrusted('x'.repeat(500)).endsWith('… (truncated)'); // true
 */
export function excerptUntrusted(value: JsonValue): string {
  let text = '';
  for (const token of jsonTokens(value, DESCRIBE_LAYOUT)) {
    text += token;
    if (text.length > DESCRIBED_VALUE_MAX_CHARS) {
      return truncatedExcerpt(text);
    }
  }
  return text;
}

/**
 * The `raw_request_sha256` of a received call: lowercase SHA-256 of the UTF-8 canonical JSON of
 * the payload as the runtime parsed it (sorted keys, no whitespace). For every finite payload
 * the bytes equal `canonicalJson(raw)`; a non-finite number, which only an out-of-range literal
 * such as `1e400` can produce, is written `Infinity` or `-Infinity`, a token canonical JSON
 * never contains, so the digest stays total without colliding with any finite payload.
 *
 * @example
 * requestDigest({ b: 1, a: 'x' }) === sha256Hex(new TextEncoder().encode('{"a":"x","b":1}')); // true
 */
export function requestDigest(raw: JsonValue): Sha256Hex {
  return sha256Hex(UTF8.encode([...jsonTokens(raw, DIGEST_LAYOUT)].join('')));
}

function* jsonTokens(root: JsonValue, layout: TokenLayout): Generator<string, void, undefined> {
  const stack: WalkFrame[] = [{ kind: 'value', value: root }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    yield frame.kind === 'text' ? frame.text : expand(frame.value, layout, stack);
  }
}

// Writes a scalar, or opens a container and schedules its members followed by its closing
// bracket. The walk keeps its own stack, so depth costs heap, never call stack.
function expand(value: JsonValue, layout: TokenLayout, stack: WalkFrame[]): string {
  if (value === null || typeof value !== 'object') {
    return scalarToken(value, layout);
  }
  if (Array.isArray(value)) {
    scheduleMembers(
      stack,
      ']',
      value.map((item): Member => [undefined, item]),
    );
    return '[';
  }
  const object = value as JsonObject;
  const keys = layout.sortKeys ? Object.keys(object).sort() : Object.keys(object);
  scheduleMembers(
    stack,
    '}',
    keys.map((key): Member => [`${quoted(key, layout)}:`, object[key] as JsonValue]),
  );
  return '{';
}

// The stack is last in, first out: members go on in reverse, each value under its separator
// and label, so they come off in order.
function scheduleMembers(stack: WalkFrame[], closing: string, members: readonly Member[]): void {
  stack.push({ kind: 'text', text: closing });
  for (const [index, [label, member]] of [...members.entries()].reverse()) {
    stack.push({ kind: 'value', value: member });
    stack.push({ kind: 'text', text: `${index === 0 ? '' : ','}${label ?? ''}` });
  }
}

function scalarToken(value: string | number | boolean | null, layout: TokenLayout): string {
  if (typeof value === 'string') {
    return quoted(value, layout);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return String(value);
  }
  return JSON.stringify(value);
}

// JSON.stringify escapes a lone surrogate (well-formed JSON.stringify), so a string cut between
// the halves of a pair is still quoted as well-formed text.
function quoted(text: string, layout: TokenLayout): string {
  return JSON.stringify(text.length > layout.maxStringChars ? text.slice(0, layout.maxStringChars) : text);
}

// Every token is well formed, so the cut can only strand the high half of a pair at its end;
// dropping it keeps the detail well formed, as its UTF-8 journal bytes require.
function truncatedExcerpt(text: string): string {
  const cut = text.slice(0, DESCRIBED_VALUE_MAX_CHARS);
  return `${cut.isWellFormed() ? cut : cut.slice(0, -1)}${TRUNCATION_MARKER}`;
}

function jsonTypeName(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}
