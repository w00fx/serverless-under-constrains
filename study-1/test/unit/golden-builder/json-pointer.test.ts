// RFC 6901 JSON Pointer edits used by the scenario operations: token unescaping, copy-on-write
// edits that share untouched members, own-property-only member lookup (so `__proto__` and
// `constructor` are ordinary names), canonical array indexes, and a result instead of a throw
// for a pointer of any depth (Owner amendment A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { memberOf, parsePointer, removeAtPointer, setAtPointer } from '../../support/golden-builder/json-pointer.ts';
import { DEEP_NESTING, parsedTower } from '../../support/kernel/deep-json.ts';

const parsed = (text: string): JsonValue => JSON.parse(text) as JsonValue;

describe('JSON pointer parsing', () => {
  it('splits and unescapes tokens, ~1 before ~0', () => {
    assert.deepEqual(parsePointer(''), { ok: true, value: [] });
    assert.deepEqual(parsePointer('/'), { ok: true, value: [''] });
    assert.deepEqual(parsePointer('/a~1b/~01/0'), { ok: true, value: ['a/b', '~1', '0'] });
  });

  it('rejects a pointer without a leading slash or with a bare tilde', () => {
    assert.deepEqual(parsePointer('a'), { ok: false, error: `pointer "a"; expected '' or a string starting with '/'` });
    assert.deepEqual(parsePointer('/a~2'), {
      ok: false,
      error: `pointer "/a~2" has a bare '~'; expected '~0' or '~1' escapes`,
    });
    assert.equal(parsePointer('/a~').ok, false);
  });
});

describe('JSON pointer members', () => {
  it('reads own members and canonical array indexes only', () => {
    assert.equal(memberOf({ a: 1 }, 'a'), 1);
    assert.equal(memberOf({}, '__proto__'), undefined);
    assert.equal(memberOf({}, 'toString'), undefined);
    assert.deepEqual(memberOf(parsed('{"__proto__":{"x":1}}'), '__proto__'), { x: 1 });
    assert.equal(memberOf([10, 20], '1'), 20);
    assert.equal(memberOf([10, 20], '01'), undefined);
    assert.equal(memberOf([10, 20], '2'), undefined);
    assert.equal(memberOf([10, 20], 'length'), undefined);
    assert.equal(memberOf('text', '0'), undefined);
    assert.equal(memberOf(null, 'a'), undefined);
  });
});

describe('JSON pointer edits', () => {
  it('sets a nested member on a copy and shares the untouched members', () => {
    const shared = { keep: [1] };
    const document = { a: { b: 1 }, shared };
    const edited = setAtPointer(document, '/a/b', 2);
    assert.deepEqual(edited, { ok: true, value: { a: { b: 2 }, shared } });
    assert.deepEqual(document, { a: { b: 1 }, shared }, 'the input is not changed');
    assert.equal(edited.ok && (edited.value as { shared: unknown }).shared, shared);
  });

  it('adds a new member, replaces array items and appends with the length or "-"', () => {
    assert.deepEqual(setAtPointer({ a: 1 }, '/b', null), { ok: true, value: { a: 1, b: null } });
    assert.deepEqual(setAtPointer([1, 2], '/0', 'x'), { ok: true, value: ['x', 2] });
    assert.deepEqual(setAtPointer([1, 2], '/2', 3), { ok: true, value: [1, 2, 3] });
    assert.deepEqual(setAtPointer([1, 2], '/-', 3), { ok: true, value: [1, 2, 3] });
    assert.deepEqual(setAtPointer({ '-': 0 }, '/-', 1), { ok: true, value: { '-': 1 } });
  });

  it('sets an inherited-looking name as an own member', () => {
    const edited = setAtPointer({}, '/__proto__', { polluted: true });
    assert.ok(edited.ok);
    assert.equal(Object.hasOwn(edited.value as object, '__proto__'), true);
    assert.equal(Object.getPrototypeOf(edited.value), Object.prototype);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });

  it('reports a missing parent, a bad index, a scalar parent and the whole-record pointer', () => {
    assert.deepEqual(setAtPointer({ a: 1 }, '/x/y', 1), {
      ok: false,
      error: 'pointer "/x/y" has no member "x"; expected an existing parent',
    });
    assert.deepEqual(setAtPointer([1], '/5', 1), {
      ok: false,
      error: 'pointer "/5" index "5"; expected 0..1 or \'-\'',
    });
    assert.equal(setAtPointer([1], '/01', 1).ok, false);
    assert.deepEqual(setAtPointer({ a: 'text' }, '/a/b', 1), {
      ok: false,
      error: 'pointer "/a/b" crosses a string; expected objects and arrays',
    });
    assert.deepEqual(setAtPointer({ a: null }, '/a/b', 1), {
      ok: false,
      error: 'pointer "/a/b" crosses a null; expected objects and arrays',
    });
    assert.deepEqual(setAtPointer({}, '', 1), {
      ok: false,
      error: "pointer '' names the whole record; expected a member pointer such as '/field'",
    });
    assert.equal(setAtPointer({}, 'a', 1).ok, false);
    assert.equal(setAtPointer({}, '/toString/x', 1).ok, false);
  });

  it('removes object members and array items on a copy', () => {
    assert.deepEqual(removeAtPointer({ a: 1, b: 2 }, '/a'), { ok: true, value: { b: 2 } });
    assert.deepEqual(removeAtPointer({ a: [1, 2, 3] }, '/a/1'), { ok: true, value: { a: [1, 3] } });
    assert.deepEqual(removeAtPointer(parsed('{"__proto__":1,"b":2}'), '/__proto__'), { ok: true, value: { b: 2 } });
  });

  it('refuses to remove a member that does not exist', () => {
    const error = 'pointer "/c" names no existing member; expected one to remove';
    assert.deepEqual(removeAtPointer({ a: 1 }, '/c'), { ok: false, error });
    assert.equal(removeAtPointer({}, '/toString').ok, false);
    assert.equal(removeAtPointer([1], '/-').ok, false);
    assert.equal(removeAtPointer({ a: 1 }, '/a/b').ok, false);
  });

  it('edits at the bottom of a tower nested past the call stack', () => {
    const tower = parsedTower('object', DEEP_NESTING);
    const pointer = '/a'.repeat(DEEP_NESTING);
    const edited = setAtPointer(tower, pointer, 2);
    assert.equal(edited.ok, true);
    const removed = removeAtPointer(tower, pointer);
    assert.equal(removed.ok, true);
    const missing = setAtPointer(tower, `${pointer}/a/b`, 1);
    assert.equal(missing.ok, false);
  });
});
