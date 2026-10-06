// Near-valid JSON objects for the differential fuzz tests of the trial-message guards: a valid
// record with up to three properties removed or replaced by boundary values. Mutated properties
// are defined as own data properties, so a `__proto__` or `constructor` mutation becomes a
// member of the serialized object instead of changing its prototype (Owner amendment A-05).

import fc from 'fast-check';

import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';

export type Mutation = readonly [string, JsonValue | undefined];

/** `base` with each mutation applied in order: `undefined` removes the property. */
export function mutated(base: JsonObject, mutations: readonly Mutation[]): JsonObject {
  const object: Record<string, JsonValue> = { ...base };
  for (const [property, value] of mutations) {
    if (value === undefined) {
      Reflect.deleteProperty(object, property);
      continue;
    }
    Object.defineProperty(object, property, { value, enumerable: true, writable: true, configurable: true });
  }
  return object;
}

/** Objects derived from `base` by up to three mutations of its properties or of `extra` ones. */
export function nearValidObjects(
  base: JsonObject,
  extra: readonly string[],
  boundaryValue: fc.Arbitrary<JsonValue>,
): fc.Arbitrary<JsonObject> {
  const mutation: fc.Arbitrary<Mutation> = fc.tuple(
    fc.constantFrom(...Object.keys(base), ...extra, 'unexpected_property', '__proto__', 'constructor'),
    fc.option(boundaryValue, { nil: undefined, freq: 4 }),
  );
  return fc.array(mutation, { maxLength: 3 }).map((mutations) => mutated(base, mutations));
}
