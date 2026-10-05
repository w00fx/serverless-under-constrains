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
