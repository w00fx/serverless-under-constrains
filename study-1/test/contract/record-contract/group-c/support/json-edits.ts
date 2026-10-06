// Multi-member edits for the cross-field rule cases: one call states every member a variant
// changes, so a case reads as the rule it breaks.

import { isJsonArray, isJsonObject } from '../../../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../../../src/record-contract/primitives.ts';
import { withMember, withValueAt } from '../../group-b/support/json-paths.ts';
import type { JsonPath } from '../../group-b/support/json-paths.ts';

/**
 * Copies a record with each listed top-level member set, or removed when its value is undefined.
 *
 * @example
 * edited(json, { preservation_verdict: 'fail', correct_completion: false });
 */
export function edited(root: JsonObject, members: Readonly<Record<string, JsonValue | undefined>>): JsonObject {
  return Object.entries(members).reduce<JsonObject>((current, [key, next]) => withMember(current, key, next), root);
}

/**
 * The JSON array at a top-level member, for cases that reorder or extend it.
 *
 * @example
 * arrayAt(json, 'entries').toReversed();
 */
export function arrayAt(root: JsonObject, key: string): readonly JsonValue[] {
  const value = root[key];
  if (!isJsonArray(value)) {
    throw new TypeError(`member ${key} is ${JSON.stringify(value)}; expected a JSON array`);
  }
  return value;
}

/**
 * Copies a record with the value at `path` set (or removed when undefined), keeping the record
 * type so further `edited` calls compose.
 *
 * @example
 * recordWithValueAt(json, ['condition_results', 0, 'result'], 'fail');
 */
export function recordWithValueAt(root: JsonObject, path: JsonPath, next: JsonValue | undefined): JsonObject {
  const copy = withValueAt(root, path, next);
  if (!isJsonObject(copy)) {
    throw new TypeError(`edit at ${JSON.stringify(path)} returned ${typeof copy}; expected a JSON object`);
  }
  return copy;
}
