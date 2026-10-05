// BR-RUA-033/034 fuzz: canonical JSON matches an independent oracle written from the rule text
// (keys sorted by UTF-16 code units, no whitespace, JSON.stringify for scalars and keys), is
// idempotent, ignores key order and keeps array order.
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
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

type MutableJson = null | boolean | number | string | MutableJson[] | { [key: string]: MutableJson };

const jsonValue = fc.jsonValue() as fc.Arbitrary<JsonValue>;

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
      fc.property(jsonValue, (value) => {
        assert.equal(canonicalJson(value), oracleCanonical(value));
      }),
      fuzzParameters(),
    );
  });

  it('is idempotent through a parse', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const once = canonicalJson(value);
        assert.equal(canonicalJson(JSON.parse(once) as JsonValue), once);
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
