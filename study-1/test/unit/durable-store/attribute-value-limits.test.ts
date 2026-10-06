// DynamoDB attribute-value limits (WP-04 review round 1). Expected values come from the sizing
// rules of CapacityUnitCalculations.html, the 32-level nesting limit of Constraints.html and the
// number range of HowItWorks.NamingRulesDataTypes.html, computed by hand.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  estimatedItemBytes,
  itemSizeViolation,
  MAX_ITEM_BYTES,
  MAX_NESTING_DEPTH,
  MIN_NUMBER_MAGNITUDE,
  nestingViolation,
  storableValueViolations,
} from '../../../src/durable-store/attribute-value-limits.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';

const SHAPE = 'a finite number, safe when integral, zero or of magnitude at least 1E-130';

function nestedMap(depth: number): JsonValue {
  let value: JsonValue = 'x';
  for (let level = 0; level < depth; level += 1) {
    value = { a: value };
  }
  return value;
}

function nestedList(depth: number): JsonValue {
  let value: JsonValue = 1;
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

describe('limit constants', () => {
  it('match the documented DynamoDB limits', () => {
    assert.equal(MAX_NESTING_DEPTH, 32);
    assert.equal(MAX_ITEM_BYTES, 409_600);
    assert.equal(MIN_NUMBER_MAGNITUDE, 1e-130);
  });
});

describe('estimatedItemBytes', () => {
  it('counts names and scalar values by the documented rules', () => {
    // names 2 + 2 + 1; values 'p' 1, 's' 1, 10000 → one significant digit → 1 + 1.
    assert.equal(estimatedItemBytes({ pk: 'p', sk: 's', n: 10000 }), 9);
    assert.equal(estimatedItemBytes({ a: true, b: null }), 4);
    assert.equal(estimatedItemBytes({ é: 'ü' }), 4);
    // 123.45 → 5 digits → 3 + 1; -0.0012 → 2 digits → 1 + 1; 0 → 1 + 1; 1000 → 1 + 1.
    assert.equal(estimatedItemBytes({ n: 123.45, m: -0.0012, z: 0, k: 1000 }), 14);
    assert.equal(estimatedItemBytes({ t: 1.5e-130 }), 3);
    assert.equal(estimatedItemBytes({}), 0);
  });

  it('adds 3 bytes per list or map and 1 byte per element', () => {
    assert.equal(estimatedItemBytes({ e: [] }), 4);
    assert.equal(estimatedItemBytes({ e: {} }), 4);
    // name 1, list 3, element 1: 1 + 2, element 'ab': 1 + 2.
    assert.equal(estimatedItemBytes({ l: [1, 'ab'] }), 10);
    // name 1, map 3, member name 'ké' 3 + overhead 1, value 'x' 1.
    assert.equal(estimatedItemBytes({ m: { ké: 'x' } }), 9);
  });

  it('sizes a value of any depth without recursion', () => {
    // name 1, outer list 3, 99,999 nested lists of 3 + 1, innermost number 1 + 2.
    assert.equal(estimatedItemBytes({ v: nestedList(100_000) }), 400_003);
  });
});

describe('itemSizeViolation', () => {
  it('accepts exactly 400 KB and refuses one byte more', () => {
    assert.equal(itemSizeViolation({ v: 'x'.repeat(409_599) }, '$'), undefined);
    assert.equal(
      itemSizeViolation({ v: 'x'.repeat(409_600) }, 'action.item'),
      'action.item is about 409601 bytes; expected at most 409600 bytes (DynamoDB item size limit)',
    );
  });
});

describe('storableValueViolations', () => {
  it('accepts scalars, and 32 levels of lists or maps', () => {
    for (const value of ['s', true, null, 0, -1e-130, 12.5, nestedMap(32), nestedList(32)]) {
      assert.deepEqual(storableValueViolations(value, '$'), [], JSON.stringify(value));
    }
  });

  it('refuses the 33rd level of a map or a list at its path', () => {
    assert.deepEqual(storableValueViolations(nestedMap(33), '$.v'), [nestingViolation(`$.v${'.a'.repeat(32)}`)]);
    assert.deepEqual(storableValueViolations(nestedList(40), '$.v'), [nestingViolation(`$.v${'[0]'.repeat(32)}`)]);
    assert.equal(
      nestingViolation('$.v'),
      '$.v nests deeper than 32 levels; expected at most 32 levels of lists and maps (DynamoDB limit)',
    );
  });

  it('names every unstorable number with its path', () => {
    assert.deepEqual(storableValueViolations({ a: [Number.NaN, 2], b: { c: 1e-200 } }, 'x'), [
      `x.a[0]: NaN is not a finite number; expected ${SHAPE}`,
      `x.b.c: 1e-200 is nonzero with a magnitude below 1E-130; expected ${SHAPE}`,
    ]);
  });
});
