// Condition → ConditionExpression: placeholders for every name and value, typed operands.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scalarAttributeValue, toConditionExpression } from '../../../src/durable-store/condition-expression.ts';
import type { Condition } from '../../../src/durable-store/item-store-port.ts';

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

describe('toConditionExpression on deep and wide conditions (WP-04 review round 2)', () => {
  it('renders 100,000 levels of all iteratively, without overflowing the call stack', () => {
    let condition: Condition = { kind: 'item_absent' };
    for (let level = 0; level < 100_000; level += 1) {
      condition = { kind: 'all', conditions: [condition] };
    }
    const parts = toConditionExpression(condition);
    assert.equal(parts.expression, `${'('.repeat(100_000)}attribute_not_exists(#c0)${')'.repeat(100_000)}`);
    assert.deepEqual(parts.names, { '#c0': 'pk' });
  });

  it('numbers placeholders left to right across a wide condition', () => {
    const parts = toConditionExpression({
      kind: 'all',
      conditions: Array.from({ length: 12 }, (_, index) => ({
        kind: 'attribute_equals' as const,
        name: `n${String(index)}`,
        value: index,
      })),
    });
    assert.equal(parts.expression.split(' AND ').at(11), '(#c11 = :c11)');
    assert.equal(parts.names['#c11'], 'n11');
    assert.deepEqual(parts.values[':c11'], { N: '11' });
  });

  it('renders a 200,000-member all without overflowing the call stack, placeholders in order', () => {
    const parts = toConditionExpression({
      kind: 'all',
      conditions: Array.from({ length: 200_000 }, () => ({ kind: 'item_absent' }) as const),
    });
    const members = parts.expression.split(' AND ');
    assert.equal(members.length, 200_000);
    assert.equal(members[0], '(attribute_not_exists(#c0))');
    assert.equal(members.at(-1), '(attribute_not_exists(#c199999))');
    assert.equal(Object.keys(parts.names).length, 200_000);
  });

  it('renders an empty all as nothing', () => {
    assert.equal(toConditionExpression({ kind: 'all', conditions: [] }).expression, '');
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
