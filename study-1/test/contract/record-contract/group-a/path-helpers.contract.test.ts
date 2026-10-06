// The path helpers every group A mutation case relies on: a mutation at a path that does not
// exist must fail loudly with the offending path, never as a raw TypeError and never by adding
// a member (a typo would otherwise pass as a rejected mutation).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withPath, withoutPath } from './support/validation-assertions.ts';

const RECORD = { a: { b: [1, { c: 'x' }] } } as const;

describe('group A path helpers', () => {
  it('withPath replaces an existing member or item in a deep copy', () => {
    assert.deepEqual(withPath(RECORD, ['a', 'b', 1, 'c'], 'y'), { a: { b: [1, { c: 'y' }] } });
    assert.deepEqual(withPath(RECORD, ['a', 'b', 0], 2), { a: { b: [2, { c: 'x' }] } });
    assert.deepEqual(RECORD, { a: { b: [1, { c: 'x' }] } });
  });

  it('withPath names the whole path when any segment is missing', () => {
    for (const path of [[], ['nope'], ['nope', 'x', 'y'], ['a', 'nope', 'y'], ['a', 'b', 2], ['a', 'b', 0, 'c']]) {
      assert.throws(
        () => withPath(RECORD, path, 1),
        new Error(`path ${JSON.stringify(path)} does not exist in the record; expected an existing property path`),
      );
    }
  });

  it('withoutPath removes an existing object member in a deep copy', () => {
    assert.deepEqual(withoutPath(RECORD, ['a', 'b', 1, 'c']), { a: { b: [1, {}] } });
    assert.deepEqual(RECORD, { a: { b: [1, { c: 'x' }] } });
  });

  it('withoutPath refuses a missing path and an array item', () => {
    assert.throws(
      () => withoutPath(RECORD, ['a', 'missing', 'c']),
      new Error('path ["a","missing","c"] does not exist in the record; expected an existing property path'),
    );
    assert.throws(
      () => withoutPath(RECORD, ['a', 'b', 0]),
      new Error('path ["a","b",0] addresses an array item; expected an object member'),
    );
  });
});
