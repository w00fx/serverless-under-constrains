// Canonical serialization (BR-RUA-033) and structural equivalence (BR-RUA-034).
//
// Canonical form: object keys sorted by UTF-16 code units, no insignificant whitespace,
// numbers in ECMAScript shortest round-trip form (so -0 is written 0), strings escaped by
// JSON.stringify. Because object order has no meaning and array order and JSON types do,
// two values are structurally equal exactly when their canonical forms are identical. The
// writer is iterative (json-text.ts), so it is total over every value the parsers return,
// however deep (WP-00 review round 1: the recursive writer threw RangeError near 2,500 levels).

import { jsonTextPieces } from './json-text.ts';
import type { JsonTextGap, JsonTextStyle } from './json-text.ts';
import type { JsonValue } from './primitives.ts';
import type { StudyRecord } from './records/index.ts';

const encoder = new TextEncoder();

const CANONICAL_STYLE: JsonTextStyle = {
  sortKeys: true,
  leafText: canonicalLeafText,
  keyText: (key) => JSON.stringify(key),
  isWalkedObject: isPlainObject,
};

/**
 * Serializes a JSON value canonically. Throws on values JSON cannot represent exactly
 * (non-finite numbers, `undefined`, functions, symbols, bigints, non-plain objects), because
 * an optional property must be omitted rather than written as `undefined` (BR-RUA-033).
 *
 * @example
 * canonicalJson({ b: [2, 1], a: 'x' }); // '{"a":"x","b":[2,1]}'
 */
export function canonicalJson(value: JsonValue): string {
  return writeCanonical(value);
}

/**
 * The canonical form of any value, or `undefined` when JSON cannot represent it exactly. Never
 * throws; for callers that key values by structure, such as duplicate detection.
 *
 * @example
 * canonicalJsonIfRepresentable({ b: 1, a: 2 }); // '{"a":2,"b":1}'
 * canonicalJsonIfRepresentable({ a: undefined }); // undefined
 */
export function canonicalJsonIfRepresentable(value: unknown): string | undefined {
  const written = canonicalPieces(value);
  return typeof written === 'string' ? written : undefined;
}

/**
 * Structural equivalence of parsed JSON (BR-RUA-034): object property order and
 * insignificant whitespace are ignored; array order and JSON types are significant.
 *
 * @example
 * structurallyEqual({ a: 1, b: 2 }, { b: 2, a: 1 }); // true
 * structurallyEqual([1, 2], [2, 1]); // false
 * structurallyEqual(1, '1'); // false
 */
export function structurallyEqual(a: JsonValue, b: JsonValue): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Encodes one record file: canonical JSON followed by a single newline, as UTF-8.
 *
 * @example
 * writeOnce('trials/t/inputs/payment.json', serializeRecordFile(payment));
 */
export function serializeRecordFile(record: StudyRecord): Uint8Array {
  return encoder.encode(`${writeCanonical(record)}\n`);
}

/**
 * Encodes JSONL: one canonical record per line, each terminated by a newline. An empty
 * list encodes to zero bytes.
 *
 * @example
 * appendBytes(serializeJsonl([sampleOne, sampleTwo]));
 */
export function serializeJsonl(records: readonly StudyRecord[]): Uint8Array {
  return encoder.encode(records.map((record) => `${writeCanonical(record)}\n`).join(''));
}

function writeCanonical(value: unknown): string {
  const written = canonicalPieces(value);
  if (typeof written === 'string') {
    return written;
  }
  const { path, value: gap } = written;
  if (typeof gap === 'number') {
    throw new TypeError(`number at ${path} is ${String(gap)}; expected a finite JSON number`);
  }
  throw new TypeError(
    `value at ${path} is ${describe(gap)}; expected null, boolean, number, string, array or plain object`,
  );
}

// The whole text, or the first value JSON cannot represent exactly.
function canonicalPieces(value: unknown): string | JsonTextGap {
  const pieces: string[] = [];
  const walk = jsonTextPieces(value, CANONICAL_STYLE);
  let step = walk.next();
  while (step.done !== true) {
    pieces.push(step.value);
    step = walk.next();
  }
  return step.value ?? pieces.join('');
}

function canonicalLeafText(value: unknown): string | undefined {
  const finite = typeof value === 'number' && Number.isFinite(value);
  return value === null || typeof value === 'boolean' || typeof value === 'string' || finite
    ? JSON.stringify(value)
    : undefined;
}

// The walker asks only about non-null, non-array objects; class instances are not JSON objects.
function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Null never reaches here (it is JSON). An object whose prototype chain has no constructor
// falls back to its built-in tag, such as [object Object].
function describe(value: unknown): string {
  if (typeof value !== 'object') {
    return `of type ${typeof value}`;
  }
  const name = (value as { readonly constructor?: { readonly name?: unknown } }).constructor?.name;
  return `an instance of ${typeof name === 'string' ? name : Object.prototype.toString.call(value)}`;
}
