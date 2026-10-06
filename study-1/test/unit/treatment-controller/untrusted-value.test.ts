// Describing an untrusted value without recursion (WP-08 review r1): a stream image or control
// item nested deeper than the call stack must still yield a reason, never a RangeError.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeUntrustedValue } from '../../../src/treatment-controller/untrusted-value.ts';
import { nestedArrays, nestedObjects } from '../../support/transport-rehearsal/deep-values.ts';

describe('describeUntrustedValue', () => {
  it('names each JSON type, with the value of a scalar', () => {
    const cases: readonly [unknown, string][] = [
      [undefined, 'absent'],
      [null, 'null null'],
      ['ABC', 'string "ABC"'],
      ['a\nb', 'string "a\\nb"'],
      [7, 'number 7'],
      [-0, 'number 0'],
      [1.5, 'number 1.5'],
      [false, 'boolean false'],
      [[], 'array of length 0'],
      [[1, [2]], 'array of length 2'],
      [{}, 'object with 0 member(s)'],
      [{ a: 1, b: { c: 2 } }, 'object with 2 member(s)'],
      [10n, 'bigint'],
      [Symbol('s'), 'symbol'],
      [(): void => undefined, 'function'],
    ];
    for (const [value, expected] of cases) {
      assert.equal(describeUntrustedValue(value), expected, expected);
    }
  });

  it('shows a string of up to 64 characters whole and cuts a longer one', () => {
    const limit = 'x'.repeat(64);
    assert.equal(describeUntrustedValue(limit), `string "${limit}"`);
    assert.equal(describeUntrustedValue(`${limit}yz`), `string "${limit}"… (66 characters)`);
  });

  it('describes values nested 100,000 levels deep without throwing', () => {
    assert.equal(describeUntrustedValue(nestedArrays(100_000)), 'array of length 1');
    assert.equal(describeUntrustedValue(nestedObjects(100_000)), 'object with 1 member(s)');
  });
});
