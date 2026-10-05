// Condition → ConditionExpression: placeholders for every name and value, typed operands.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scalarAttributeValue, toConditionExpression } from '../../../src/durable-store/condition-expression.ts';

describe('toConditionExpression', () => {
  it('item_absent tests the partition key through a name placeholder', () => {
    assert.deepEqual(toConditionExpression({ kind: 'item_absent' }), {
      expression: 'attribute_not_exists(#c0)',
      names: { '#c0': 'pk' },
      values: {},
    });
  });

  it('attribute_equals compares through placeholders, keeping reserved words out of the text', () => {
    assert.deepEqual(toConditionExpression({ kind: 'attribute_equals', name: 'state', value: 'ARMED' }), {
      expression: '#c0 = :c0',
      names: { '#c0': 'state' },
      values: { ':c0': { S: 'ARMED' } },
    });
    assert.deepEqual(toConditionExpression({ kind: 'attribute_equals', name: 'version', value: 7 }), {
      expression: '#c0 = :c0',
      names: { '#c0': 'version' },
      values: { ':c0': { N: '7' } },
    });
  });

  it('attribute_in lists one value placeholder per allowed string', () => {
    assert.deepEqual(
      toConditionExpression({ kind: 'attribute_in', name: 'lease_status', values: ['RELEASED', 'EXPIRED'] }),
      {
        expression: '#c0 IN (:c0, :c1)',
        names: { '#c0': 'lease_status' },
        values: { ':c0': { S: 'RELEASED' }, ':c1': { S: 'EXPIRED' } },
      },
    );
  });

  it('all joins parenthesized members with AND and numbers placeholders across the tree', () => {
    const parts = toConditionExpression({
      kind: 'all',
      conditions: [
        { kind: 'attribute_equals', name: 'owner_id', value: 'me' },
        {
          kind: 'all',
          conditions: [
            { kind: 'attribute_in', name: 'status', values: ['HELD'] },
            { kind: 'attribute_equals', name: 'fenced', value: false },
          ],
        },
        { kind: 'item_absent' },
      ],
    });
    assert.deepEqual(parts, {
      expression: '(#c0 = :c0) AND ((#c1 IN (:c1)) AND (#c2 = :c2)) AND (attribute_not_exists(#c3))',
      names: { '#c0': 'owner_id', '#c1': 'status', '#c2': 'fenced', '#c3': 'pk' },
      values: { ':c0': { S: 'me' }, ':c1': { S: 'HELD' }, ':c2': { BOOL: false } },
    });
  });

  it('a single-member all is still parenthesized', () => {
    assert.equal(
      toConditionExpression({ kind: 'all', conditions: [{ kind: 'item_absent' }] }).expression,
      '(attribute_not_exists(#c0))',
    );
  });
});

describe('scalarAttributeValue', () => {
  it('keeps the JSON type of the operand', () => {
    assert.deepEqual(scalarAttributeValue('1'), { S: '1' });
    assert.deepEqual(scalarAttributeValue(1), { N: '1' });
    assert.deepEqual(scalarAttributeValue(-2.5), { N: '-2.5' });
    assert.deepEqual(scalarAttributeValue(true), { BOOL: true });
    assert.deepEqual(scalarAttributeValue(false), { BOOL: false });
  });
});
