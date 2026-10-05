// Total structural equality and duplicate detection over parsed JSON (Owner amendment A-02
// audit): they back the kernel's `uniqueItems`, so they must never throw on hostile JSON such as
// `{"toString":1,"valueOf":1}`, own `__proto__` members or null-prototype objects.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findDuplicateItems, sameJsonValue } from '../../../src/record-contract/json-value.ts';

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
});
