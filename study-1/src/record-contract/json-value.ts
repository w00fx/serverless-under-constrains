// Type guards over parsed JSON shared by the record-contract modules.

import { canonicalJsonIfRepresentable } from './canonical-json.ts';
import { jsonTextPieces } from './json-text.ts';
import type { JsonTextStyle } from './json-text.ts';
import type { JsonObject, JsonValue } from './primitives.ts';

/**
 * The most characters of JSON text an error detail quotes. Details describe untrusted values,
 * so a multi-megabyte or deeply nested value must not become a multi-megabyte detail.
 */
export const QUOTED_JSON_LIMIT = 200;

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
 * Describes a JSON value for an error message: its JSON type and its serialized form, cut to
 * `QUOTED_JSON_LIMIT` characters. Never throws, however large or deep the value.
 *
 * @example
 * describeJson([1]); // 'array [1]'
 * describeJson(undefined); // 'absent'
 */
export function describeJson(value: JsonValue | undefined): string {
  if (value === undefined) {
    return 'absent';
  }
  return `${jsonTypeName(value)} ${boundedJsonText(value)}`;
}

/**
 * The JSON text of a value exactly as `JSON.stringify` writes it when that text has at most
 * `limit` characters; otherwise its first `limit` characters followed by `…[truncated]`. Built
 * iteratively and stopped at the limit, so it is total and bounded over hostile input.
 *
 * @example
 * boundedJsonText({ a: [1] }); // '{"a":[1]}'
 * boundedJsonText('x'.repeat(500), 4); // '"xxx…[truncated]'
 */
export function boundedJsonText(value: JsonValue, limit: number = QUOTED_JSON_LIMIT): string {
  let text = '';
  for (const piece of jsonTextPieces(value, boundedStyle(limit))) {
    text += piece;
    if (text.length > limit) {
      return `${text.slice(0, limit)}…[truncated]`;
    }
  }
  return text;
}

// Strings are cut before quoting: a cut string still overflows the limit (its quotes add two
// characters), and escapes only push later characters further out, so the kept prefix is
// exactly JSON.stringify's.
function boundedStyle(limit: number): JsonTextStyle {
  const quote = (text: string): string => JSON.stringify(text.length > limit ? text.slice(0, limit + 1) : text);
  return {
    sortKeys: false,
    leafText: (leaf) => (typeof leaf === 'string' ? quote(leaf) : JSON.stringify(leaf)),
    keyText: quote,
    isWalkedObject: () => true,
  };
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
 * JSON types are significant (BR-RUA-034). It walks an explicit work list instead of recursing,
 * so nesting deeper than the call stack is compared, not a RangeError (WP-00 review round 1).
 *
 * @example
 * sameJsonValue({ a: [1] }, { a: [1] }); // true
 * sameJsonValue([], {}); // false
 */
export function sameJsonValue(a: unknown, b: unknown): boolean {
  const pending: (readonly [unknown, unknown])[] = [[a, b]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [left, right] = pair;
    if (left === right) {
      continue;
    }
    if (!isObjectLike(left) || !isObjectLike(right) || Array.isArray(left) !== Array.isArray(right)) {
      return false;
    }
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length || !keys.every((key) => Object.hasOwn(right, key))) {
      return false;
    }
    // One push per member: spreading a huge member list into push() overflows the argument limit.
    for (const key of keys) {
      pending.push([left[key], right[key]]);
    }
  }
  return true;
}

/**
 * Finds a repeated item, as Ajv's `uniqueItems` reports one: the last item that repeats an
 * earlier one, paired with the nearest such earlier item. `undefined` means all items differ.
 * Items are keyed by their canonical form, so the scan is linear in the size of the array;
 * structural equality and canonical identity coincide on JSON (canonical-json.ts). Only an
 * array holding a value JSON cannot represent falls back to pairwise comparison.
 *
 * @example
 * findDuplicateItems(['a', 'b', 'a']); // { earlier: 0, later: 2 }
 */
export function findDuplicateItems(items: readonly unknown[]): DuplicateItems | undefined {
  const keys: string[] = [];
  for (const item of items) {
    const key = canonicalJsonIfRepresentable(item);
    if (key === undefined) {
      return findDuplicatePairwise(items);
    }
    keys.push(key);
  }
  const lastIndexOf = new Map<string, number>();
  let found: DuplicateItems | undefined;
  keys.forEach((key, later) => {
    const earlier = lastIndexOf.get(key);
    found = earlier === undefined ? found : { earlier, later };
    lastIndexOf.set(key, later);
  });
  return found;
}

function findDuplicatePairwise(items: readonly unknown[]): DuplicateItems | undefined {
  for (let later = items.length - 1; later > 0; later -= 1) {
    const earlier = items.findLastIndex((other, index) => index < later && sameJsonValue(other, items[later]));
    if (earlier !== -1) {
      return { earlier, later };
    }
  }
  return undefined;
}

function isObjectLike(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}
