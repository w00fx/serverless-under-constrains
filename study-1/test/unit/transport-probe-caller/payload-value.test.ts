// Describing a payload value without recursion (WP-08 review r1): the runner's invocation
// payload may nest deeper than the call stack, and a refusal must still name it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describePayloadValue } from '../../../src/transport-probe-caller/payload-value.ts';
import { nestedArrays, nestedObjects } from '../../support/transport-rehearsal/deep-values.ts';

describe('describePayloadValue', () => {
  it('names each JSON type, with the value of a scalar', () => {
    const cases: readonly [unknown, string][] = [
      [undefined, 'absent'],
      [null, 'null null'],
      ['ABC', 'string "ABC"'],
      [7, 'number 7'],
      [-1.25, 'number -1.25'],
      [true, 'boolean true'],
      [[], 'array of length 0'],
      [[[1], 2, 3], 'array of length 3'],
      [{}, 'object with 0 member(s)'],
      [{ a: [1] }, 'object with 1 member(s)'],
      [10n, 'bigint'],
    ];
    for (const [value, expected] of cases) {
      assert.equal(describePayloadValue(value), expected, expected);
    }
  });

  it('shows a string of up to 64 characters whole and cuts a longer one', () => {
    const limit = 'p'.repeat(64);
    assert.equal(describePayloadValue(limit), `string "${limit}"`);
    assert.equal(describePayloadValue(`${limit}q`), `string "${limit}"… (65 characters)`);
  });

  it('describes values nested 100,000 levels deep without throwing', () => {
    assert.equal(describePayloadValue(nestedArrays(100_000)), 'array of length 1');
    assert.equal(describePayloadValue(nestedObjects(100_000)), 'object with 1 member(s)');
  });
});
