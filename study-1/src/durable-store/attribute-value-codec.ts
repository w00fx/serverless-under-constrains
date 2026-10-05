// JSON ↔ DynamoDB AttributeValue codec for stored items.
//
// The store keeps only JSON (BR-RUA-033 records and state items), so the codec maps exactly
// the six JSON-compatible AttributeValue members: S, N, BOOL, NULL, L and M
// (https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_AttributeValue.html).
// Sets and binary are never written, so decoding them is an error rather than a guess.
// Numbers travel as decimal strings; an integral number must be a safe integer so that every
// encoded value decodes back to the same JavaScript number (BR-RUA-033: amounts are
// safe-integer JSON numbers).

import type { AttributeValue } from '@aws-sdk/client-dynamodb';

import { isJsonObject } from '../record-contract/json-value.ts';
import type { JsonObject, JsonValue, Result } from '../record-contract/primitives.ts';
import type { StoredItem } from './item-store-port.ts';

export type AttributeMap = Record<string, AttributeValue>;

const DYNAMODB_NUMBER_PATTERN = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * Tells why a number cannot be stored exactly, or `undefined` when it can.
 *
 * @example
 * unencodableNumberReason(Number.NaN); // 'NaN is not a finite number'
 * unencodableNumberReason(2 ** 53); // '9007199254740992 is an integer outside the safe-integer range'
 */
export function unencodableNumberReason(value: number): string | undefined {
  if (!Number.isFinite(value)) {
    return `${String(value)} is not a finite number`;
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return `${String(value)} is an integer outside the safe-integer range`;
  }
  return undefined;
}

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
    defineOwn(encoded, name, encodeAttributeValue(value, `${path}.${name}`));
  }
  return encoded;
}

/**
 * Decodes one AttributeValue received from DynamoDB. Total: any other shape is an error that
 * names the offending value and the expected shape.
 *
 * @example
 * decodeAttributeValue({ N: '3' }); // { ok: true, value: 3 }
 * decodeAttributeValue({ SS: ['a'] }); // { ok: false, error: '... expected exactly one of S, N, BOOL, NULL, L or M' }
 */
export function decodeAttributeValue(value: unknown, path = '$'): Result<JsonValue, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: `${path} is ${describeUnknown(value)}; expected an AttributeValue object` };
  }
  const members = Object.entries(value);
  const [member] = members;
  if (members.length !== 1 || member === undefined) {
    return {
      ok: false,
      error: `${path} has members ${JSON.stringify(Object.keys(value))}; expected exactly one of S, N, BOOL, NULL, L or M`,
    };
  }
  return decodeMember(member[0], member[1], path);
}

/**
 * Decodes a full item received from DynamoDB; it must carry string `pk` and `sk` attributes.
 *
 * @example
 * decodeStoredItem({ pk: { S: 'p' }, sk: { S: 's' } }); // { ok: true, value: { pk: 'p', sk: 's' } }
 */
export function decodeStoredItem(value: unknown): Result<StoredItem, string> {
  const decoded = decodeMapMember(value, '$');
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

function encodeNumber(value: number, path: string): string {
  const reason = unencodableNumberReason(value);
  if (reason !== undefined) {
    throw new RangeError(`number at ${path}: ${reason}; expected a finite number, safe when integral`);
  }
  return String(value);
}

function decodeMember(member: string, content: unknown, path: string): Result<JsonValue, string> {
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
      return decodeList(content, path);
    case 'M':
      return decodeMapMember(content, path);
    default:
      return {
        ok: false,
        error: `${path} has member ${JSON.stringify(member)}; expected exactly one of S, N, BOOL, NULL, L or M`,
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
    return memberError(path, 'N', content, 'a finite number, safe when integral');
  }
  return { ok: true, value };
}

function decodeList(content: unknown, path: string): Result<JsonValue, string> {
  if (!Array.isArray(content)) {
    return memberError(path, 'L', content, 'an array of AttributeValues');
  }
  const values: JsonValue[] = [];
  for (const [index, element] of (content as readonly unknown[]).entries()) {
    const decoded = decodeAttributeValue(element, `${path}[${String(index)}]`);
    if (!decoded.ok) {
      return decoded;
    }
    values.push(decoded.value);
  }
  return { ok: true, value: values };
}

function decodeMapMember(content: unknown, path: string): Result<JsonObject, string> {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    return memberError(path, 'M', content, 'an object of AttributeValues');
  }
  const values: Record<string, JsonValue> = {};
  for (const [name, element] of Object.entries(content)) {
    const decoded = decodeAttributeValue(element, `${path}.${name}`);
    if (!decoded.ok) {
      return decoded;
    }
    defineOwn(values, name, decoded.value);
  }
  return { ok: true, value: values };
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
// be JSON-serializable when the input did not come from DynamoDB.
function describeUnknown(value: unknown): string {
  if (Array.isArray(value)) {
    return `an array of length ${String(value.length)}`;
  }
  if (typeof value === 'object' && value !== null) {
    return `an object with members ${JSON.stringify(Object.keys(value))}`;
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return value === undefined ? 'absent' : `a ${typeof value}`;
}
