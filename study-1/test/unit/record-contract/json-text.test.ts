// The iterative JSON text writer shared by canonical serialization and bounded error details.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { jsonTextPieces } from '../../../src/record-contract/json-text.ts';
import type { JsonTextGap, JsonTextStyle } from '../../../src/record-contract/json-text.ts';

const INSERTION_ORDER: JsonTextStyle = {
  sortKeys: false,
  leafText: (value) => (typeof value === 'number' || typeof value === 'string' ? JSON.stringify(value) : undefined),
  keyText: (key) => `<${key}>`,
  isWalkedObject: (value) => !(value instanceof Date),
};

function written(
  value: unknown,
  style: JsonTextStyle = INSERTION_ORDER,
): { text: string; gap: JsonTextGap | undefined } {
  const pieces: string[] = [];
  const walk = jsonTextPieces(value, style);
  for (let step = walk.next(); ; step = walk.next()) {
    if (step.done === true) {
      return { text: pieces.join(''), gap: step.value };
    }
    pieces.push(step.value);
  }
}

describe('jsonTextPieces', () => {
  it('writes leaves, arrays and objects with separators, keys through keyText and no whitespace', () => {
    assert.deepEqual(written(7), { text: '7', gap: undefined });
    assert.deepEqual(written([]), { text: '[]', gap: undefined });
    assert.deepEqual(written({}), { text: '{}', gap: undefined });
    assert.deepEqual(written([1, [2, 'x'], { b: 3, a: [] }]), {
      text: '[1,[2,"x"],{<b>:3,<a>:[]}]',
      gap: undefined,
    });
  });

  it('keeps insertion order or sorts keys by UTF-16 code units', () => {
    const value = { b: 1, a: 2, '10': 3, '9': 4 };
    assert.equal(written(value).text, '{<9>:4,<10>:3,<b>:1,<a>:2}');
    assert.equal(written(value, { ...INSERTION_ORDER, sortKeys: true }).text, '{<10>:3,<9>:4,<a>:2,<b>:1}');
  });

  it('stops at the first value leafText cannot spell and names its path', () => {
    assert.deepEqual(written(true), { text: '', gap: { path: '$', value: true } });
    assert.deepEqual(written({ a: [1, { b: null }] }), {
      text: '{<a>:[1,{<b>:',
      gap: { path: '$.a[1].b', value: null },
    });
    const date = new Date(0);
    assert.deepEqual(written([1, 2, date]), { text: '[1,2,', gap: { path: '$[2]', value: date } });
  });

  it('writes a missing array slot as a gap at its index', () => {
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    assert.deepEqual(written(sparse), { text: '[1,', gap: { path: '$[1]', value: undefined } });
  });

  it('walks nesting far deeper than the call stack', () => {
    let deep: unknown = 1;
    for (let level = 0; level < 100_000; level += 1) {
      deep = [deep];
    }
    const { text, gap } = written(deep);
    assert.equal(gap, undefined);
    assert.equal(text, `${'['.repeat(100_000)}1${']'.repeat(100_000)}`);
  });

  it('lets a consumer stop early without walking the rest', () => {
    let visited = 0;
    const counting: JsonTextStyle = {
      ...INSERTION_ORDER,
      leafText: (value) => {
        visited += 1;
        return JSON.stringify(value);
      },
    };
    const walk = jsonTextPieces(
      Array.from({ length: 1000 }, (_, index) => index),
      counting,
    );
    assert.deepEqual([walk.next().value, walk.next().value, walk.next().value], ['[', '', '0']);
    assert.equal(visited, 1);
  });
});
