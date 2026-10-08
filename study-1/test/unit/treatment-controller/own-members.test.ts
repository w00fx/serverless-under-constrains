// Own-member reads of untrusted parsed objects (Owner amendment A-05): inherited names are never
// read as data, and an own `__proto__` member stays a plain member.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ownMember, ownMembers } from '../../../src/treatment-controller/own-members.ts';

const INHERITED_NAMES = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', '__proto__'];

describe('ownMember', () => {
  it('reads an own member and never an inherited one', () => {
    assert.deepEqual(ownMember({ Records: [] }, 'Records'), []);
    assert.equal(ownMember({ a: undefined }, 'a'), undefined);
    for (const name of INHERITED_NAMES) {
      assert.equal(ownMember({}, name), undefined, name);
    }
    assert.equal(ownMember(Object.create({ Records: [1] }) as Record<string, unknown>, 'Records'), undefined);
    const parsed = JSON.parse('{"__proto__":{"x":1},"constructor":2}') as Record<string, unknown>;
    assert.deepEqual(ownMember(parsed, '__proto__'), { x: 1 });
    assert.equal(ownMember(parsed, 'constructor'), 2);
  });
});

describe('ownMembers', () => {
  it('copies exactly the own enumerable members onto an object with no prototype', () => {
    const parsed = JSON.parse('{"__proto__":{"source":"probe_caller"},"a":[1],"constructor":"c"}') as Record<
      string,
      unknown
    >;
    const own = ownMembers(parsed);
    assert.equal(Object.getPrototypeOf(own), null);
    assert.deepEqual(Object.keys(own), ['__proto__', 'a', 'constructor']);
    assert.deepEqual(own['__proto__'], { source: 'probe_caller' });
    assert.equal(own['source'], undefined);
    assert.equal(own['a'], parsed['a'], 'members are shared, not deep-copied');
    assert.equal(own.constructor, 'c');
    for (const name of INHERITED_NAMES.filter((name) => name !== '__proto__' && name !== 'constructor')) {
      assert.equal(own[name], undefined, name);
    }
  });

  it('drops inherited members of the source object', () => {
    const inherited = Object.assign(Object.create({ source: 'probe_caller' }) as Record<string, unknown>, { a: 1 });
    assert.equal(inherited['source'], 'probe_caller');
    const own = ownMembers(inherited);
    assert.equal(own['source'], undefined);
    assert.deepEqual(Object.keys(own), ['a']);
  });
});
