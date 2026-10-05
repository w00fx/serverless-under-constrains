// Canonical serialization (BR-RUA-033) and structural equivalence (BR-RUA-034).
//
// Canonical form: object keys sorted by UTF-16 code units, no insignificant whitespace,
// numbers in ECMAScript shortest round-trip form (so -0 is written 0), strings escaped by
// JSON.stringify. Because object order has no meaning and array order and JSON types do,
// two values are structurally equal exactly when their canonical forms are identical.

import type { JsonValue } from './primitives.ts';
import type { StudyRecord } from './records/index.ts';

const encoder = new TextEncoder();

/**
 * Serializes a JSON value canonically. Throws on values JSON cannot represent exactly
 * (non-finite numbers, `undefined`, functions, symbols, bigints, non-plain objects), because
 * an optional property must be omitted rather than written as `undefined` (BR-RUA-033).
 *
 * @example
 * canonicalJson({ b: [2, 1], a: 'x' }); // '{"a":"x","b":[2,1]}'
 */
export function canonicalJson(value: JsonValue): string {
  return writeCanonical(value, '$');
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
  return encoder.encode(`${writeCanonical(record, '$')}\n`);
}

/**
 * Encodes JSONL: one canonical record per line, each terminated by a newline. An empty
 * list encodes to zero bytes.
 *
 * @example
 * appendBytes(serializeJsonl([sampleOne, sampleTwo]));
 */
export function serializeJsonl(records: readonly StudyRecord[]): Uint8Array {
  return encoder.encode(records.map((record) => `${writeCanonical(record, '$')}\n`).join(''));
}

function writeCanonical(value: unknown, path: string): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return writeNumber(value, path);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, (item: unknown, index) => writeCanonical(item, `${path}[${String(index)}]`)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return writeObject(value, path);
  }
  throw new TypeError(
    `value at ${path} is ${describe(value)}; expected null, boolean, number, string, array or plain object`,
  );
}

function writeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`number at ${path} is ${String(value)}; expected a finite JSON number`);
  }
  return JSON.stringify(value);
}

function writeObject(value: Readonly<Record<string, unknown>>, path: string): string {
  const members = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${writeCanonical(value[key], `${path}.${key}`)}`);
  return `{${members.join(',')}}`;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
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
