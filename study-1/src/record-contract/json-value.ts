// Type guards over parsed JSON shared by the record-contract modules.

import type { JsonObject, JsonValue } from './primitives.ts';

/**
 * Narrows a parsed JSON value to a JSON object (not an array, not null).
 *
 * @example
 * if (isJsonObject(parsed)) use(parsed['record_type']);
 */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows a parsed JSON value to a JSON array.
 *
 * @example
 * if (isJsonArray(schema['allOf'])) schema['allOf'].forEach(visit);
 */
export function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/**
 * Describes a JSON value for an error message: its JSON type and its serialized form.
 *
 * @example
 * describeJson([1]); // 'array [1]'
 * describeJson(undefined); // 'absent'
 */
export function describeJson(value: JsonValue | undefined): string {
  if (value === undefined) {
    return 'absent';
  }
  return `${jsonTypeName(value)} ${JSON.stringify(value)}`;
}

function jsonTypeName(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

/** The two positions of a repeated item, as Ajv's `uniqueItems` reports them (`j` before `i`). */
export interface DuplicateItems {
  readonly earlier: number;
  readonly later: number;
}

/**
 * Structural equality of parsed JSON that never throws: it reads only own enumerable members,
 * so it is total over hostile values such as `{"toString":1,"valueOf":1}` or null-prototype
 * objects. Ajv's built-in comparison (fast-deep-equal) calls an object's own `valueOf` and
 * throws on them (Owner amendment A-02 audit). Object member order is ignored; array order and
 * JSON types are significant (BR-RUA-034).
 *
 * @example
 * sameJsonValue({ a: [1] }, { a: [1] }); // true
 * sameJsonValue([], {}); // false
 */
export function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (!isObjectLike(a) || !isObjectLike(b) || Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJsonValue(a[key], b[key]))
  );
}

/**
 * Finds a repeated item, scanning as Ajv's `uniqueItems` does: the last item that repeats an
 * earlier one, paired with the nearest such earlier item. `undefined` means all items differ.
 *
 * @example
 * findDuplicateItems(['a', 'b', 'a']); // { earlier: 0, later: 2 }
 */
export function findDuplicateItems(items: readonly unknown[]): DuplicateItems | undefined {
  const later = items.findLastIndex((item, index) => items.slice(0, index).some((other) => sameJsonValue(other, item)));
  if (later === -1) {
    return undefined;
  }
  const earlier = items.slice(0, later).findLastIndex((other) => sameJsonValue(other, items[later]));
  return { earlier, later };
}

function isObjectLike(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}
