// UpdateAction → UpdateExpression: SET and ADD clauses in code-unit order with `u` placeholders.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toUpdateExpression } from '../../../src/durable-store/update-expression.ts';

describe('toUpdateExpression', () => {
  it('builds a SET clause in code-unit order, independent of object order', () => {
    const expected = {
      expression: 'SET #u0 = :u0, #u1 = :u1, #u2 = :u2',
      names: { '#u0': 'B', '#u1': 'a', '#u2': 'b' },
      values: { ':u0': { NULL: true }, ':u1': { M: { x: { L: [] } } }, ':u2': { S: 'two' } },
    };
    assert.deepEqual(toUpdateExpression({ b: 'two', a: { x: [] }, B: null }), expected);
    assert.deepEqual(toUpdateExpression({ B: null, b: 'two', a: { x: [] } }), expected);
  });

  it('builds an ADD clause for increments after the SET clause', () => {
    assert.deepEqual(toUpdateExpression({ state: 'COMMITTED_WAITING' }, { version: 1, lease_version: -2 }), {
      expression: 'SET #u0 = :u0 ADD #u1 :u1, #u2 :u2',
      names: { '#u0': 'state', '#u1': 'lease_version', '#u2': 'version' },
      values: { ':u0': { S: 'COMMITTED_WAITING' }, ':u1': { N: '-2' }, ':u2': { N: '1' } },
    });
  });

  it('omits an empty clause', () => {
    assert.deepEqual(toUpdateExpression({}, { count: 3 }), {
      expression: 'ADD #u0 :u0',
      names: { '#u0': 'count' },
      values: { ':u0': { N: '3' } },
    });
    assert.deepEqual(toUpdateExpression({ only: true }), {
      expression: 'SET #u0 = :u0',
      names: { '#u0': 'only' },
      values: { ':u0': { BOOL: true } },
    });
    assert.deepEqual(toUpdateExpression({}, {}), { expression: '', names: {}, values: {} });
  });

  it('refuses an unencodable value, naming the attribute', () => {
    assert.throws(() => toUpdateExpression({ amount: Number.POSITIVE_INFINITY }), {
      message:
        'number at $.amount: Infinity is not a finite number; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
    });
  });
});
