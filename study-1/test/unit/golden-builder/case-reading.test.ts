// Total readers over an untrusted case value (Owner amendments A-05, A-07): closed objects read
// through own data properties only, arrays without holes or accessors, patterned strings, safe
// integers, closed choices and exactly representable JSON — each reporting the location, the
// offending value and the expected shape instead of throwing.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeValue,
  readArray,
  readChoice,
  readInteger,
  readJson,
  readObject,
  readString,
} from '../../support/golden-builder/case-reading.ts';
import type { Problems } from '../../support/golden-builder/case-reading.ts';

describe('readObject', () => {
  it('reads required and optional own data members', () => {
    const problems: Problems = [];
    const fields = readObject({ a: 1, b: 'x' }, 'case', ['a'], ['b', 'c'], problems);
    assert.deepEqual(problems, []);
    assert.deepEqual(
      [...(fields ?? [])],
      [
        ['a', 1],
        ['b', 'x'],
      ],
    );
  });

  it('rejects non-objects, naming the value', () => {
    for (const [value, described] of [
      [null, 'null null'],
      [[1], 'array [1]'],
      ['s', 'string "s"'],
      [undefined, 'a non-JSON undefined'],
    ] as const) {
      const problems: Problems = [];
      assert.equal(readObject(value, 'case', [], [], problems), undefined);
      assert.deepEqual(problems, [`case is ${described}; expected an object`]);
    }
  });

  it('reports unknown, missing, accessor and symbol members (a closed shape)', () => {
    const problems: Problems = [];
    const value: Record<string | symbol, unknown> = { extra: 1 };
    Object.defineProperty(value, 'a', { get: () => 1, enumerable: true });
    value[Symbol('s')] = 1;
    readObject(value, 'case', ['a', 'b'], [], problems);
    assert.deepEqual(problems, [
      'case has symbol-keyed members; expected string keys only',
      'case has unknown member "extra"; expected only a, b',
      'case.a is an accessor; expected a data property',
      'case.a is missing; expected it to be present',
      'case.b is missing; expected it to be present',
    ]);
  });

  it('never reads inherited members as declared fields', () => {
    const problems: Problems = [];
    const fields = readObject(Object.create({ a: 1 }) as object, 'case', ['a'], ['toString'], problems);
    assert.equal(fields?.has('toString'), false);
    assert.deepEqual(problems, ['case.a is missing; expected it to be present']);
    const own: Problems = [];
    readObject(JSON.parse('{"__proto__":1}'), 'case', [], [], own);
    assert.deepEqual(own, ['case has unknown member "__proto__"; expected no members']);
  });
});

describe('readArray', () => {
  it('reads the items of a dense data array', () => {
    const problems: Problems = [];
    assert.deepEqual(readArray([1, 'a'], 'list', problems), [1, 'a']);
    assert.deepEqual(problems, []);
  });

  it('rejects a non-array, a hole and an accessor item', () => {
    const problems: Problems = [];
    assert.equal(readArray({ length: 0 }, 'list', problems), undefined);
    // eslint-disable-next-line no-sparse-arrays -- the hole is the input under test
    assert.equal(readArray([1, , 3], 'list', problems), undefined);
    const accessor: unknown[] = [1];
    Object.defineProperty(accessor, 0, { get: () => 1 });
    assert.equal(readArray(accessor, 'list', problems), undefined);
    assert.deepEqual(problems, [
      'list is object {"length":0}; expected an array',
      'list[1] is a hole or an accessor; expected a data item',
      'list[0] is a hole or an accessor; expected a data item',
    ]);
  });
});

describe('scalar readers', () => {
  it('reads a patterned string', () => {
    const problems: Problems = [];
    assert.equal(readString('abc', 'id', /^[a-z]+$/, problems), 'abc');
    assert.equal(readString('ABC', 'id', /^[a-z]+$/, problems), undefined);
    assert.equal(readString(1, 'id', /^[a-z]+$/, problems), undefined);
    assert.deepEqual(problems, [
      'id is string "ABC"; expected a string matching /^[a-z]+$/',
      'id is number 1; expected a string matching /^[a-z]+$/',
    ]);
  });

  it('reads a safe integer at or above a minimum', () => {
    const problems: Problems = [];
    assert.equal(readInteger(1, 'n', 1, problems), 1);
    for (const value of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1']) {
      assert.equal(readInteger(value, 'n', 1, problems), undefined);
    }
    assert.equal(problems.length, 6);
    assert.equal(problems[2], 'n is number NaN; expected a safe integer of at least 1');
    assert.equal(problems[3], 'n is number Infinity; expected a safe integer of at least 1');
  });

  it('reads one of a closed set of choices', () => {
    const problems: Problems = [];
    assert.equal(readChoice('b', 'kind', ['a', 'b'], problems), 'b');
    assert.equal(readChoice('toString', 'kind', ['a', 'b'], problems), undefined);
    assert.deepEqual(problems, ['kind is string "toString"; expected one of a, b']);
  });

  it('reads only exactly representable JSON', () => {
    const problems: Problems = [];
    assert.deepEqual(readJson({ a: [1, null] }, 'expected', problems), { a: [1, null] });
    for (const value of [{ a: Number.NaN }, [undefined], { f: (): void => undefined }, new Date(0), -0]) {
      readJson(value, 'expected', problems);
    }
    assert.ok(problems.length >= 4);
    assert.ok(problems.every((problem) => problem.startsWith('expected is ')));
  });
});

describe('describeValue', () => {
  it('describes JSON, non-finite numbers and non-JSON values, bounded', () => {
    assert.equal(describeValue(Number.NEGATIVE_INFINITY), 'number -Infinity');
    assert.equal(describeValue(true), 'boolean true');
    assert.equal(describeValue({ a: 1 }), 'object {"a":1}');
    assert.equal(describeValue(Symbol('s')), 'a non-JSON symbol');
    assert.equal(describeValue(10n), 'a non-JSON bigint');
    assert.ok(describeValue('x'.repeat(10_000)).length < 1_000);
  });
});
