// Total structural equality and duplicate detection over parsed JSON (Owner amendment A-02
// audit): they back the kernel's `uniqueItems`, so they must never throw on hostile JSON such as
// `{"toString":1,"valueOf":1}`, own `__proto__` members or null-prototype objects.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  QUOTED_JSON_LIMIT,
  boundedJsonText,
  describeJson,
  findDuplicateItems,
  sameJsonValue,
} from '../../../src/record-contract/json-value.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';

function parsed(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function nullPrototype(members: Readonly<Record<string, unknown>>): unknown {
  return Object.assign(Object.create(null) as Record<string, unknown>, members);
}

describe('sameJsonValue', () => {
  it('compares scalars by value and JSON type', () => {
    assert.equal(sameJsonValue('a', 'a'), true);
    assert.equal(sameJsonValue(1, 1), true);
    assert.equal(sameJsonValue(null, null), true);
    assert.equal(sameJsonValue(1, 2), false);
    assert.equal(sameJsonValue(1, '1'), false);
    assert.equal(sameJsonValue(true, 1), false);
  });

  it('never treats a scalar or null as equal to a container', () => {
    assert.equal(sameJsonValue(1, {}), false);
    assert.equal(sameJsonValue({}, 1), false);
    assert.equal(sameJsonValue(null, {}), false);
    assert.equal(sameJsonValue({}, null), false);
    assert.equal(sameJsonValue('a', { 0: 'a' }), false);
    assert.equal(sameJsonValue({ 0: 'a' }, 'a'), false);
  });

  it('distinguishes arrays from objects with the same members', () => {
    assert.equal(sameJsonValue([], {}), false);
    assert.equal(sameJsonValue({}, []), false);
    assert.equal(sameJsonValue(['a'], { 0: 'a' }), false);
  });

  it('ignores object member order and respects array order', () => {
    assert.equal(sameJsonValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true);
    assert.equal(sameJsonValue([1, 2], [2, 1]), false);
    assert.equal(sameJsonValue([1, 2], [1, 2]), true);
    assert.equal(sameJsonValue([1], [1, 1]), false);
  });

  it('requires the same member names and equal values for every member', () => {
    assert.equal(sameJsonValue({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(sameJsonValue({ a: 1, b: 2 }, { a: 1 }), false);
    assert.equal(sameJsonValue({ a: 1 }, { a: 2 }), false);
    assert.equal(sameJsonValue({ a: 1, b: 2 }, { a: 1, b: 3 }), false);
    assert.equal(sameJsonValue({ a: 1 }, { b: 1 }), false);
  });

  it('reads only own members, so an own __proto__ never matches an inherited prototype', () => {
    assert.equal(sameJsonValue(parsed('{"__proto__":{}}'), parsed('{"x":1}')), false);
    assert.equal(sameJsonValue(parsed('{"__proto__":{}}'), parsed('{"__proto__":{}}')), true);
  });

  it('is total over hostile and null-prototype objects', () => {
    const hostile = parsed('{"toString":1,"valueOf":1}');
    assert.equal(sameJsonValue(hostile, parsed('{"toString":1,"valueOf":1}')), true);
    assert.equal(sameJsonValue(hostile, parsed('{"toString":1,"valueOf":2}')), false);
    assert.equal(sameJsonValue(nullPrototype({}), nullPrototype({})), true);
    assert.equal(sameJsonValue(nullPrototype({ a: hostile }), { a: parsed('{"valueOf":1,"toString":1}') }), true);
    assert.equal(sameJsonValue(nullPrototype({ a: 1 }), nullPrototype({ a: 2 })), false);
  });
});

describe('findDuplicateItems', () => {
  it('returns undefined when every item differs', () => {
    assert.equal(findDuplicateItems([]), undefined);
    assert.equal(findDuplicateItems(['a']), undefined);
    assert.equal(findDuplicateItems(['a', 'b', 1, '1', [], {}]), undefined);
  });

  it('pairs the last repeated item with its nearest earlier copy, as Ajv does', () => {
    assert.deepEqual(findDuplicateItems(['a', 'a']), { earlier: 0, later: 1 });
    assert.deepEqual(findDuplicateItems(['a', 'b', 'a']), { earlier: 0, later: 2 });
    assert.deepEqual(findDuplicateItems(['a', 'a', 'a']), { earlier: 1, later: 2 });
    assert.deepEqual(findDuplicateItems(['b', 'b', 'a', 'c']), { earlier: 0, later: 1 });
    assert.deepEqual(findDuplicateItems(['x', 'b', 'b', 'a', 'a']), { earlier: 3, later: 4 });
  });

  it('compares items structurally and totally', () => {
    assert.deepEqual(findDuplicateItems([{ a: [1] }, { a: [1] }]), { earlier: 0, later: 1 });
    const hostile = parsed('[{"toString":1,"valueOf":1},{"valueOf":1,"toString":1}]') as readonly unknown[];
    assert.deepEqual(findDuplicateItems(hostile), { earlier: 0, later: 1 });
    assert.deepEqual(findDuplicateItems([nullPrototype({}), nullPrototype({})]), { earlier: 0, later: 1 });
    assert.equal(findDuplicateItems([nullPrototype({ a: 1 }), nullPrototype({ a: 2 })]), undefined);
  });

  it('falls back to pairwise comparison for an item JSON cannot represent, with the same pairing', () => {
    assert.deepEqual(findDuplicateItems([{ a: undefined }, 'x', { a: undefined }]), { earlier: 0, later: 2 });
    assert.deepEqual(findDuplicateItems([1, undefined, 1, undefined]), { earlier: 1, later: 3 });
    assert.deepEqual(findDuplicateItems([undefined, 'a', 'a', 'b']), { earlier: 1, later: 2 });
    assert.equal(findDuplicateItems([{ a: undefined }, { a: null }, {}]), undefined);
  });

  it('keys items by structure, so equal objects in any member order collide and types stay apart', () => {
    assert.deepEqual(
      findDuplicateItems([
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ]),
      { earlier: 0, later: 1 },
    );
    assert.equal(findDuplicateItems([1, '1', true, 'true', null, 'null', [1], { 0: 1 }]), undefined);
    assert.deepEqual(findDuplicateItems([0, -0]), { earlier: 0, later: 1 });
  });

  it('scans a long array of distinct items and finds a late repeat', () => {
    const ids = Array.from({ length: 50_000 }, (_, index) => `id-${String(index)}`);
    assert.equal(findDuplicateItems(ids), undefined);
    assert.deepEqual(findDuplicateItems([...ids, 'id-7']), { earlier: 7, later: 50_000 });
  });
});

describe('boundedJsonText and describeJson', () => {
  it('writes exactly what JSON.stringify writes while the text fits the limit', () => {
    const values: readonly JsonValue[] = [
      null,
      true,
      -0,
      1e21,
      'quote " \\ \n \u0001 \ud800',
      [],
      {},
      [1, [2, { b: 'x', a: null }]],
      JSON.parse('{"__proto__":{"toString":1},"10":1,"9":2}') as JsonValue,
    ];
    for (const value of values) {
      assert.equal(boundedJsonText(value), JSON.stringify(value));
    }
  });

  it('keeps a text of exactly the limit and cuts one character more', () => {
    assert.equal(boundedJsonText('abc', 5), '"abc"');
    assert.equal(boundedJsonText('abcd', 5), '"abcd…[truncated]');
    assert.equal(boundedJsonText([1, 2], 5), '[1,2]');
    assert.equal(boundedJsonText([1, 23], 5), '[1,23…[truncated]');
    assert.equal(boundedJsonText({ abc: 1 }, 4), '{"ab…[truncated]');
    assert.equal(boundedJsonText('x'.repeat(QUOTED_JSON_LIMIT - 2)).length, QUOTED_JSON_LIMIT);
    assert.equal(
      boundedJsonText('x'.repeat(QUOTED_JSON_LIMIT - 1)),
      `"${'x'.repeat(QUOTED_JSON_LIMIT - 1)}…[truncated]`,
    );
  });

  it('cuts a string before quoting and keeps exactly the prefix JSON.stringify writes', () => {
    // An escape near the cut must not shift the kept prefix: '"ab\\n"' keeps '"ab\\'.
    assert.equal(boundedJsonText('ab\n', 4), '"ab\\…[truncated]');
    assert.equal(boundedJsonText('ab\u{1F600}cd', 5), '"ab\u{1F600}…[truncated]');
  });

  it('describes a value by its JSON type and its bounded text', () => {
    assert.equal(describeJson(undefined), 'absent');
    assert.equal(describeJson(null), 'null null');
    assert.equal(describeJson(7), 'number 7');
    assert.equal(describeJson(['a']), 'array ["a"]');
    assert.equal(describeJson({ a: 'b' }), 'object {"a":"b"}');
    assert.equal(describeJson('y'.repeat(500)), `string "${'y'.repeat(QUOTED_JSON_LIMIT - 1)}…[truncated]`);
  });
});
