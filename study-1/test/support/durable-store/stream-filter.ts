// Lambda event-filtering patterns for the DynamoDB Streams emulator (design §12.2 `StreamFeed`).
//
// Only the exact-match subset of the EventBridge pattern syntax is supported, because it is
// the only form this study configures (design §9.5): an object whose leaves are arrays of
// allowed scalar values. A record matches when every key of the pattern matches (AND); up to
// five patterns combine with OR (F-2). Matching is exact and case-sensitive, and DynamoDB
// number values are strings, so no numeric comparison exists
// (https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html,
// https://docs.aws.amazon.com/lambda/latest/dg/with-ddb-filtering.html).
// Any other operator (prefix, exists, numeric, anything-but …) is refused at construction
// rather than guessed.

import { isJsonObject } from '../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';

export const MAX_FILTER_PATTERNS = 5;

/**
 * Parses and checks one filter pattern (a JSON string, as in `FilterCriteria.Filters[].Pattern`,
 * or an object). Throws a RangeError naming the unsupported part.
 *
 * @example
 * parseFilterPattern('{"eventName":["INSERT"]}'); // { eventName: ['INSERT'] }
 */
export function parseFilterPattern(pattern: string | JsonObject): JsonObject {
  const parsed: unknown = typeof pattern === 'string' ? JSON.parse(pattern) : pattern;
  if (!isJsonObject(parsed as JsonValue) || Object.keys(parsed as JsonObject).length === 0) {
    throw new RangeError(`filter pattern ${JSON.stringify(parsed)}; expected a non-empty JSON object`);
  }
  checkRules(parsed as JsonObject, '$');
  return parsed as JsonObject;
}

/**
 * Checks a list of patterns: 1 to 5, as the event source mapping allows by default.
 *
 * @example
 * parseFilterPatterns([callerTimeoutPattern]);
 */
export function parseFilterPatterns(patterns: readonly (string | JsonObject)[]): readonly JsonObject[] {
  if (patterns.length > MAX_FILTER_PATTERNS) {
    throw new RangeError(`${String(patterns.length)} filter patterns; expected at most ${String(MAX_FILTER_PATTERNS)}`);
  }
  return patterns.map((pattern) => parseFilterPattern(pattern));
}

/**
 * Tells whether a record passes a filter list: no patterns pass everything, otherwise any
 * matching pattern passes it.
 *
 * @example
 * passesFilters([{ eventName: ['INSERT'] }], { eventName: 'MODIFY' }); // false
 */
export function passesFilters(patterns: readonly JsonObject[], record: JsonValue): boolean {
  return patterns.length === 0 || patterns.some((pattern) => matchesPattern(pattern, record));
}

function matchesPattern(pattern: JsonObject, value: JsonValue | undefined): boolean {
  return Object.entries(pattern).every(([key, rule]) => {
    const field = isJsonObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
    return Array.isArray(rule) ? matchesAllowedValues(rule, field) : matchesPattern(rule as JsonObject, field);
  });
}

// A missing field never matches; DynamoDB attribute values are objects of scalars, so a field
// compared against an allowed-value list is always a scalar or absent.
function matchesAllowedValues(allowed: readonly JsonValue[], field: JsonValue | undefined): boolean {
  return field !== undefined && allowed.includes(field);
}

function checkRules(pattern: JsonObject, path: string): void {
  for (const [key, rule] of Object.entries(pattern)) {
    const location = `${path}.${key}`;
    if (isJsonObject(rule)) {
      checkRules(rule, location);
      continue;
    }
    const scalars = isNonEmptyScalarList(rule);
    if (!scalars) {
      throw new RangeError(
        `filter rule at ${location} is ${JSON.stringify(rule)}; expected a non-empty array of exact-match scalars`,
      );
    }
  }
}

function isNonEmptyScalarList(rule: JsonValue): boolean {
  if (!Array.isArray(rule)) {
    return false;
  }
  const entries = rule as readonly JsonValue[];
  return entries.length > 0 && entries.every((entry) => typeof entry !== 'object' || entry === null);
}
