// Deeply nested values for the totality regressions of WP-08 review r1, shared by the
// treatment-controller and transport-probe-caller tests. Built iteratively, so
// building them never overflows the stack the code under test must not overflow either.

import type { JsonValue } from '../../../src/record-contract/primitives.ts';

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
