// Deeply nested values for the totality regressions of WP-08 review r1 and Owner amendment A-05
// (at least 100,000 levels), shared by the treatment-controller and transport-probe-caller tests.
// Built iteratively, so building them never overflows the stack the code under test must not
// overflow either.

import { QUOTED_JSON_LIMIT } from '../../../src/record-contract/json-value.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';

/** The depth every A-05 deep-nesting regression uses (the amendment's minimum). */
export const HOSTILE_DEPTH = 100_000;

/**
 * How the kernel's `describeJson` names `nestedArrays(depth)` once the text passes its quote
 * limit: the first QUOTED_JSON_LIMIT characters, then the truncation mark.
 */
export const DESCRIBED_DEEP_ARRAYS = `array ${'['.repeat(QUOTED_JSON_LIMIT)}…[truncated]`;

/** The same for `nestedObjects(depth)`: `{"a":` repeated, cut at the limit. */
export const DESCRIBED_DEEP_OBJECTS = `object ${'{"a":'.repeat(QUOTED_JSON_LIMIT).slice(0, QUOTED_JSON_LIMIT)}…[truncated]`;

/** `[[[…[]…]]]` with `depth` arrays. */
export function nestedArrays(depth: number): JsonValue {
  let value: JsonValue = [];
  for (let level = 1; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

/** `{a:{a:…{}…}}` with `depth` objects. */
export function nestedObjects(depth: number): JsonValue {
  let value: JsonValue = {};
  for (let level = 1; level < depth; level += 1) {
    value = { a: value };
  }
  return value;
}

/** An AttributeValue of `levels` nested maps around a string: `{M:{a:{M:…{a:{S:'leaf'}}…}}}`. */
export function nestedMapAttribute(levels: number): JsonValue {
  let value: JsonValue = { S: 'leaf' };
  for (let level = 0; level < levels; level += 1) {
    value = { M: { a: value } };
  }
  return value;
}
