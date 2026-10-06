// BR-RUA-033/034 fuzz: canonical JSON matches an independent oracle written from the rule text
// (keys sorted by UTF-16 code units, no whitespace, JSON.stringify for scalars and keys), is
// idempotent, ignores key order and keeps array order. Since WP-00 review round 1, 2% of the
// oracle and idempotence cases are towers nested 2,500-10,000 levels deep (past the call stack,
// where the recursive writer threw RangeError), whose canonical text the oracle builds without
// recursion.
//
// Promoted counterexample (seed -1582680199, path 19:2:1:1:7:4:5): `{"0":null,"":[]}`. The first
// oracle rebuilt objects with sorted keys and called JSON.stringify, but JavaScript enumerates
// integer-like keys first, so the oracle was wrong; the unit suite pins that input.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { canonicalJson, structurallyEqual } from '../../../src/record-contract/canonical-json.ts';
import { isJsonObject } from '../../../src/record-contract/json-value.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { parsedJson, towerText } from '../../support/kernel/deep-json.ts';
import type { TowerShape } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

type MutableJson = null | boolean | number | string | MutableJson[] | { [key: string]: MutableJson };

const jsonValue = fc.jsonValue() as fc.Arbitrary<JsonValue>;

interface CanonicalCase {
  readonly value: JsonValue;
  readonly expected: string;
}

const towerCase: fc.Arbitrary<CanonicalCase> = fc
  .record({
    shape: fc.constantFrom<TowerShape>('array', 'object', 'mixed'),
    depth: fc.integer({ min: 2_500, max: 10_000 }),
    leaf: fc.jsonValue({ maxDepth: 1 }) as fc.Arbitrary<JsonValue>,
  })
  .map(({ shape, depth, leaf }) => ({
    value: parsedJson(towerText(shape, depth, JSON.stringify(leaf))),
    expected: towerText(shape, depth, oracleCanonical(leaf)),
  }));
const canonicalCase: fc.Arbitrary<CanonicalCase> = fc.oneof(
  { arbitrary: jsonValue.map((value) => ({ value, expected: oracleCanonical(value) })), weight: 49 },
  { arbitrary: towerCase, weight: 1 },
);

function oracleCanonical(value: JsonValue): string {
  if (isJsonObject(value)) {
    const members = Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${oracleCanonical(value[key] as JsonValue)}`);
    return `{${members.join(',')}}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: JsonValue) => oracleCanonical(item)).join(',')}]`;
  }
  return JSON.stringify(value);
}

function rebuildObjects(value: JsonValue, orderKeys: (keys: string[]) => string[]): MutableJson {
  if (Array.isArray(value)) {
    return value.map((item: JsonValue) => rebuildObjects(item, orderKeys));
  }
  if (!isJsonObject(value)) {
    return value as MutableJson;
  }
  const rebuilt: Record<string, MutableJson> = {};
  for (const key of orderKeys(Object.keys(value))) {
    Object.defineProperty(rebuilt, key, {
      value: rebuildObjects(value[key] as JsonValue, orderKeys),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return rebuilt;
}

describe('canonical JSON fuzz', () => {
  it('equals the oracle written from the serialization rule', () => {
    fc.assert(
      fc.property(canonicalCase, ({ value, expected }) => {
        assert.equal(canonicalJson(value), expected);
      }),
      fuzzParameters(),
    );
  });

  it('is idempotent through a parse and structurally equal to its parse', () => {
    fc.assert(
      fc.property(canonicalCase, ({ value }) => {
        const once = canonicalJson(value);
        const reparsed = JSON.parse(once) as JsonValue;
        assert.equal(canonicalJson(reparsed), once);
        assert.ok(structurallyEqual(value, reparsed));
      }),
      fuzzParameters(),
    );
  });

  it('ignores object key order', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const reversed = rebuildObjects(value, (keys) => keys.toReversed()) as JsonValue;
        assert.equal(canonicalJson(reversed), canonicalJson(value));
        assert.ok(structurallyEqual(reversed, value));
      }),
      fuzzParameters(),
    );
  });

  it('keeps array order significant', () => {
    const distinctPair = fc.tuple(jsonValue, jsonValue).filter(([a, b]) => canonicalJson(a) !== canonicalJson(b));
    fc.assert(
      fc.property(distinctPair, fc.array(jsonValue, { maxLength: 3 }), ([a, b], rest) => {
        assert.equal(structurallyEqual([a, b, ...rest], [b, a, ...rest]), false);
      }),
      fuzzParameters(),
    );
  });
});
