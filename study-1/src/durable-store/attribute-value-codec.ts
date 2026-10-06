// JSON ↔ DynamoDB AttributeValue codec for stored items.
//
// The store keeps only JSON (BR-RUA-033 records and state items), so the codec maps exactly
// the six JSON-compatible AttributeValue members: S, N, BOOL, NULL, L and M
// (https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_AttributeValue.html).
// Sets and binary are never written, so decoding them is an error rather than a guess.
// Numbers travel as decimal strings; an integral number must be a safe integer so that every
// encoded value decodes back to the same JavaScript number (BR-RUA-033: amounts are
// safe-integer JSON numbers).
// Decoding is total over untrusted input (stream records reach it from the Lambda event): it
// refuses nesting past DynamoDB's 32-level limit instead of recursing until the call stack
// overflows (WP-04 review round 1), so its recursion depth is bounded. Its error messages quote
// untrusted strings and member names only through the kernel's `boundedJsonText`, and build
// paths through `memberPath`, so they stay short however large the input (WP-04 review round 2,
// Owner amendment A-05).

import type { AttributeValue } from '@aws-sdk/client-dynamodb';

import { boundedJsonText, isJsonObject } from '../record-contract/json-value.ts';
import type { JsonObject, JsonValue, Result } from '../record-contract/primitives.ts';
import { memberPath } from './attribute-path.ts';
import {
  MAX_NESTING_DEPTH,
  nestingViolation,
  STORABLE_NUMBER_SHAPE,
  unencodableNumberReason,
} from './attribute-value-limits.ts';
import type { StoredItem } from './item-store-port.ts';

export { unencodableNumberReason } from './attribute-value-limits.ts';

export type AttributeMap = Record<string, AttributeValue>;

const DYNAMODB_NUMBER_PATTERN = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * Encodes one JSON value as a DynamoDB AttributeValue. Throws a RangeError naming the path
 * when a number cannot round-trip (callers validate first, see `write-action-validation.ts`).
 *
 * @example
 * encodeAttributeValue({ amount_minor: 10000, tags: ['a'] });
 * // { M: { amount_minor: { N: '10000' }, tags: { L: [{ S: 'a' }] } } }
 */
export function encodeAttributeValue(value: JsonValue, path = '$'): AttributeValue {
  if (value === null) {
    return { NULL: true };
  }
  if (typeof value === 'boolean') {
    return { BOOL: value };
  }
  if (typeof value === 'string') {
    return { S: value };
  }
  if (typeof value === 'number') {
    return { N: encodeNumber(value, path) };
  }
  if (isJsonObject(value)) {
    return { M: encodeAttributeMap(value, path) };
  }
  return { L: value.map((element, index) => encodeAttributeValue(element, `${path}[${String(index)}]`)) };
}

/**
 * Encodes the attributes of an item (or of an update's `set` clause) as an AttributeValue map.
 *
 * @example
 * encodeAttributeMap({ pk: 'p', sk: 's', state: 'ARMED' });
 * // { pk: { S: 'p' }, sk: { S: 's' }, state: { S: 'ARMED' } }
 */
export function encodeAttributeMap(attributes: JsonObject, path = '$'): AttributeMap {
  const encoded: AttributeMap = {};
  for (const [name, value] of Object.entries(attributes)) {
    defineOwn(encoded, name, encodeAttributeValue(value, memberPath(path, name)));
  }
  return encoded;
}

/**
 * Decodes one AttributeValue received from DynamoDB. Total: any other shape, and lists or maps
 * nested deeper than 32 levels, is an error that names the offending value and the expected
 * shape; it never throws.
 *
 * @example
 * decodeAttributeValue({ N: '3' }); // { ok: true, value: 3 }
 * decodeAttributeValue({ SS: ['a'] }); // { ok: false, error: '... expected exactly one of S, N, BOOL, NULL, L or M' }
 */
export function decodeAttributeValue(value: unknown, path = '$'): Result<JsonValue, string> {
  return readSafely(path, () => decodeAtDepth(value, path, 0));
}

/**
 * Decodes a full item received from DynamoDB; it must carry string `pk` and `sk` attributes.
 * Total like `decodeAttributeValue`; the item's own map is not a nesting level.
 *
 * @example
 * decodeStoredItem({ pk: { S: 'p' }, sk: { S: 's' } }); // { ok: true, value: { pk: 'p', sk: 's' } }
 */
export function decodeStoredItem(value: unknown): Result<StoredItem, string> {
  return readSafely('$', () => decodeItem(value));
}

function decodeItem(value: unknown): Result<StoredItem, string> {
  const decoded = decodeMapMember(value, '$', 0);
  if (!decoded.ok) {
    return decoded;
  }
  const { pk, sk } = decoded.value;
  if (typeof pk !== 'string' || typeof sk !== 'string') {
    return {
      ok: false,
      error: `item key is pk=${describeUnknown(pk)}, sk=${describeUnknown(sk)}; expected string pk and sk attributes`,
    };
  }
  return { ok: true, value: { ...decoded.value, pk, sk } };
}

// `depth` counts the lists and maps that enclose `value` (attribute-value-limits.ts).
function decodeAtDepth(value: unknown, path: string, depth: number): Result<JsonValue, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: `${path} is ${describeUnknown(value)}; expected an AttributeValue object` };
  }
  const members = Object.entries(value);
  const [member] = members;
  if (members.length !== 1 || member === undefined) {
    return {
      ok: false,
      error: `${path} has members ${boundedJsonText(Object.keys(value))}; expected exactly one of S, N, BOOL, NULL, L or M`,
    };
  }
  return decodeMember(member[0], member[1], path, depth);
}

function encodeNumber(value: number, path: string): string {
  const reason = unencodableNumberReason(value);
  if (reason !== undefined) {
    throw new RangeError(`number at ${path}: ${reason}; expected ${STORABLE_NUMBER_SHAPE}`);
  }
  return String(value);
}

function decodeMember(member: string, content: unknown, path: string, depth: number): Result<JsonValue, string> {
  switch (member) {
    case 'S':
      return typeof content === 'string'
        ? { ok: true, value: content }
        : memberError(path, member, content, 'a string');
    case 'N':
      return decodeNumber(content, path);
    case 'BOOL':
      return typeof content === 'boolean'
        ? { ok: true, value: content }
        : memberError(path, member, content, 'a boolean');
    case 'NULL':
      return content === true ? { ok: true, value: null } : memberError(path, member, content, 'true');
    case 'L':
      return depth < MAX_NESTING_DEPTH ? decodeList(content, path, depth + 1) : nestingError(path);
    case 'M':
      return depth < MAX_NESTING_DEPTH ? decodeMapMember(content, path, depth + 1) : nestingError(path);
    default:
      return {
        ok: false,
        error: `${path} has member ${boundedJsonText(member)}; expected exactly one of S, N, BOOL, NULL, L or M`,
      };
  }
}

function decodeNumber(content: unknown, path: string): Result<JsonValue, string> {
  if (typeof content !== 'string' || !DYNAMODB_NUMBER_PATTERN.test(content)) {
    return memberError(path, 'N', content, 'a decimal number string');
  }
  // A value that rounds to an unsafe integer (for example '9007199254740993' or
  // '12345678901234567890.5') could not be written back unchanged, so it is refused.
  const value = Number(content);
  if (unencodableNumberReason(value) !== undefined) {
    return memberError(path, 'N', content, STORABLE_NUMBER_SHAPE);
  }
  return { ok: true, value };
}

// `memberDepth` is the depth of the elements (one more than the list's own depth).
function decodeList(content: unknown, path: string, memberDepth: number): Result<JsonValue, string> {
  if (!Array.isArray(content)) {
    return memberError(path, 'L', content, 'an array of AttributeValues');
  }
  const values: JsonValue[] = [];
  for (const [index, element] of (content as readonly unknown[]).entries()) {
    const decoded = decodeAtDepth(element, `${path}[${String(index)}]`, memberDepth);
    if (!decoded.ok) {
      return decoded;
    }
    values.push(decoded.value);
  }
  return { ok: true, value: values };
}

// `memberDepth` is the depth of the members: one more than a nested map's own depth, and 0 for
// the item's own map, which is not a nesting level.
function decodeMapMember(content: unknown, path: string, memberDepth: number): Result<JsonObject, string> {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    return memberError(path, 'M', content, 'an object of AttributeValues');
  }
  const values: Record<string, JsonValue> = {};
  for (const [name, element] of Object.entries(content)) {
    const decoded = decodeAtDepth(element, memberPath(path, name), memberDepth);
    if (!decoded.ok) {
      return decoded;
    }
    defineOwn(values, name, decoded.value);
  }
  return { ok: true, value: values };
}

// The nesting bound keeps the recursion shallow, so the remaining way to throw is input that is
// not plain data: an accessor or a proxy trap that throws while it is read. That is refused too.
function readSafely<T>(path: string, decode: () => Result<T, string>): Result<T, string> {
  try {
    return decode();
  } catch (error) {
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : 'a non-Error value';
    return { ok: false, error: `${path} could not be read (${cause}); expected plain AttributeValue data` };
  }
}

function nestingError(path: string): { ok: false; error: string } {
  return { ok: false, error: nestingViolation(path) };
}

function memberError(path: string, member: string, content: unknown, expected: string): { ok: false; error: string } {
  return { ok: false, error: `${path}.${member} is ${describeUnknown(content)}; expected ${expected}` };
}

// An attribute may be named `__proto__`; plain assignment would replace the prototype instead
// of creating the attribute, so every attribute is defined as an own enumerable property.
function defineOwn<T>(target: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

// Describes any value for an error message without serializing nested content, which may not
// be JSON-serializable when the input did not come from DynamoDB; strings and member lists are
// cut to the kernel's quoting limit.
function describeUnknown(value: unknown): string {
  if (Array.isArray(value)) {
    return `an array of length ${String(value.length)}`;
  }
  if (typeof value === 'object' && value !== null) {
    return `an object with members ${boundedJsonText(Object.keys(value))}`;
  }
  if (typeof value === 'string') {
    return boundedJsonText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return value === undefined ? 'absent' : `a ${typeof value}`;
}
