// Stack-safe appends (WP-04 review round 2): order is kept, and a list far wider than V8's
// spread-argument limit is appended without a RangeError.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pushEach } from '../../../src/durable-store/push-each.ts';

describe('pushEach', () => {
  it('appends every item after the existing ones, in order', () => {
    const target = ['a'];
    pushEach(target, ['b', 'c']);
    assert.deepEqual(target, ['a', 'b', 'c']);
    pushEach(target, []);
    assert.deepEqual(target, ['a', 'b', 'c']);
  });

  it('appends 500,000 items, more than one call can take as spread arguments', () => {
    const items = Array.from({ length: 500_000 }, (_, index) => index);
    const target: number[] = [-1];
    pushEach(target, items);
    assert.equal(target.length, 500_001);
    assert.equal(target[0], -1);
    assert.equal(target[1], 0);
    assert.equal(target.at(-1), 499_999);
  });
});
