// DynamoDB expression-parameter and transaction limits (Constraints.html, "Expression
// parameters" and "DynamoDB transactions"), measured iteratively (WP-04 review round 2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { estimatedValueBytes, utf8Bytes } from '../../../src/durable-store/attribute-value-limits.ts';
import {
  conditionNesting,
  conditionOperatorCount,
  expressionLimitViolations,
  MAX_CONDITION_NESTING,
  MAX_EXPRESSION_BYTES,
  MAX_EXPRESSION_OPERATORS,
  MAX_SUBSTITUTION_BYTES,
  MAX_TRANSACTION_DATA_BYTES,
  transactionDataBytes,
} from '../../../src/durable-store/expression-limits.ts';
import type { Condition, WriteAction } from '../../../src/durable-store/item-store-port.ts';

const PK = 'p';
const SK = 's';

// `leaf` wrapped in `depth` single-member `all` conditions, built without recursion.
function nestedAll(depth: number, leaf: Condition): Condition {
  let condition = leaf;
  for (let level = 0; level < depth; level += 1) {
    condition = { kind: 'all', conditions: [condition] };
  }
  return condition;
}

function check(condition: Condition): WriteAction {
  return { kind: 'condition_check', table: 'control', key: { pk: PK, sk: SK }, condition };
}

const leaf: Condition = { kind: 'item_absent' };

describe('expression limit constants', () => {
  it('match the documented limits', () => {
    assert.equal(MAX_EXPRESSION_BYTES, 4096);
    assert.equal(MAX_EXPRESSION_OPERATORS, 300);
    assert.equal(MAX_SUBSTITUTION_BYTES, 2_097_152);
    assert.equal(MAX_TRANSACTION_DATA_BYTES, 4_194_304);
    // (4096 - 9) / 2: two parentheses per level around the 9-byte `#c0 = :c0`.
    assert.equal(MAX_CONDITION_NESTING, 2043);
  });
});

describe('conditionNesting', () => {
  it('counts enclosing all conditions, taking the deepest branch', () => {
    assert.equal(conditionNesting({ kind: 'item_absent' }), 0);
    assert.equal(conditionNesting({ kind: 'all', conditions: [] }), 0);
    assert.equal(conditionNesting(nestedAll(1, { kind: 'item_absent' })), 1);
    assert.equal(
      conditionNesting({
        kind: 'all',
        conditions: [{ kind: 'item_absent' }, nestedAll(3, { kind: 'item_absent' }), { kind: 'item_absent' }],
      }),
      4,
    );
  });

  it('measures 100,000 levels without overflowing the call stack', () => {
    assert.equal(conditionNesting(nestedAll(100_000, { kind: 'item_absent' })), 100_000);
  });

  it('measures a 200,000-member all without overflowing the call stack', () => {
    const wide: Condition = { kind: 'all', conditions: Array.from({ length: 200_000 }, () => nestedAll(1, leaf)) };
    assert.equal(conditionNesting(wide), 2);
  });
});

describe('conditionOperatorCount', () => {
  it('counts a 200,000-member all without overflowing the call stack', () => {
    const wide: Condition = { kind: 'all', conditions: Array.from({ length: 200_000 }, () => leaf) };
    assert.equal(conditionOperatorCount(wide), 399_999);
    assert.deepEqual(
      expressionLimitViolations(check(wide), 'action').at(-1),
      `action.condition has 399999 operators or functions; expected at most 300 (DynamoDB expression limit)`,
    );
  });

  it('counts one per comparison, IN or function, plus one AND between members', () => {
    assert.equal(conditionOperatorCount({ kind: 'item_absent' }), 1);
    assert.equal(conditionOperatorCount({ kind: 'attribute_equals', name: 'a', value: 1 }), 1);
    assert.equal(conditionOperatorCount({ kind: 'attribute_in', name: 'a', values: ['x', 'y', 'z'] }), 1);
    assert.equal(conditionOperatorCount({ kind: 'all', conditions: [] }), 0);
    assert.equal(conditionOperatorCount(nestedAll(5, { kind: 'item_absent' })), 1);
    assert.equal(
      conditionOperatorCount({
        kind: 'all',
        conditions: [
          { kind: 'item_absent' },
          { kind: 'all', conditions: [{ kind: 'item_absent' }, { kind: 'item_absent' }] },
        ],
      }),
      5,
    );
  });
});

describe('expressionLimitViolations', () => {
  it('accepts a condition expression of exactly 4096 bytes and refuses a longer one', () => {
    // 2042 levels add 4084 bytes of parentheses around `#c0 IN (:c0)` (12 bytes).
    const atLimit = check(nestedAll(2042, { kind: 'attribute_in', name: 'a', values: ['x'] }));
    assert.deepEqual(expressionLimitViolations(atLimit, 'action'), []);
    const over = check(nestedAll(2042, { kind: 'attribute_in', name: 'a', values: ['x', 'y'] }));
    assert.deepEqual(expressionLimitViolations(over, 'action'), [
      'action.condition expression is 4101 bytes long; expected at most 4096 bytes (DynamoDB expression limit)',
    ]);
  });

  it('accepts 299 operators and refuses 301 (an AND-joined condition always counts an odd number)', () => {
    const equalities = (count: number): Condition => ({
      kind: 'all',
      conditions: Array.from({ length: count }, () => ({ kind: 'attribute_equals', name: 'a', value: 1 }) as const),
    });
    assert.deepEqual(expressionLimitViolations(check(equalities(150)), 'action'), []);
    assert.deepEqual(expressionLimitViolations(check(equalities(151)), 'action'), [
      'action.condition has 301 operators or functions; expected at most 300 (DynamoDB expression limit)',
    ]);
  });

  it('measures the update expression of an update and the condition of a put', () => {
    const update = (count: number): WriteAction => ({
      kind: 'update',
      table: 'control',
      key: { pk: PK, sk: SK },
      set: Object.fromEntries(Array.from({ length: count }, (_, index) => [`a${String(index)}`, 1])),
      condition: { kind: 'item_absent' },
    });
    assert.deepEqual(expressionLimitViolations(update(287), 'action'), []);
    assert.deepEqual(expressionLimitViolations(update(288), 'action'), [
      'action.update expression is 4102 bytes long; expected at most 4096 bytes (DynamoDB expression limit)',
    ]);
    const put: WriteAction = {
      kind: 'put',
      table: 'ledger',
      item: { pk: PK, sk: SK },
      condition: nestedAll(2042, { kind: 'attribute_in', name: 'a', values: ['x', 'y'] }),
    };
    assert.deepEqual(expressionLimitViolations(put, 'actions[3]'), [
      'actions[3].condition expression is 4101 bytes long; expected at most 4096 bytes (DynamoDB expression limit)',
    ]);
    assert.deepEqual(expressionLimitViolations({ kind: 'put', table: 'ledger', item: { pk: PK, sk: SK } }, 'a'), []);
  });

  it('accepts substitution variables of exactly 2 MB and refuses one byte more', () => {
    // The name `a` (1 byte) plus the string value.
    const equals = (bytes: number): WriteAction =>
      check({ kind: 'attribute_equals', name: 'a', value: 'x'.repeat(bytes) });
    assert.deepEqual(expressionLimitViolations(equals(MAX_SUBSTITUTION_BYTES - 1), 'action'), []);
    assert.deepEqual(expressionLimitViolations(equals(MAX_SUBSTITUTION_BYTES), 'action'), [
      'action has about 2097153 bytes of expression attribute names and values; expected at most 2097152 bytes (DynamoDB expression limit)',
    ]);
  });

  it('sums the names and values of the condition and the update of one request', () => {
    // Names: pk (item_absent) 2, c 1, v 1, n 1 = 5 bytes. Values: 999_998 + length of v + 2 for
    // the number 7. A 1_097_147-character v makes exactly 2_097_152 bytes.
    const update = (length: number): WriteAction => ({
      kind: 'update',
      table: 'control',
      key: { pk: PK, sk: SK },
      set: { v: 'x'.repeat(length) },
      increment: { n: 7 },
      condition: {
        kind: 'all',
        conditions: [{ kind: 'item_absent' }, { kind: 'attribute_in', name: 'c', values: ['y'.repeat(999_998)] }],
      },
    });
    assert.equal(utf8Bytes('pk') + 3 + 999_998 + 1_097_147 + estimatedValueBytes(7), MAX_SUBSTITUTION_BYTES);
    assert.deepEqual(expressionLimitViolations(update(1_097_147), 'action'), []);
    assert.deepEqual(expressionLimitViolations(update(1_097_148), 'action'), [
      'action has about 2097153 bytes of expression attribute names and values; expected at most 2097152 bytes (DynamoDB expression limit)',
    ]);
  });
});

describe('transactionDataBytes', () => {
  it('sums put items and update keys, sets and increments; condition checks write nothing', () => {
    assert.equal(transactionDataBytes([]), 0);
    assert.equal(transactionDataBytes([{ kind: 'put', table: 'ledger', item: { pk: PK, sk: SK, v: 'abc' } }]), 10);
    assert.equal(
      transactionDataBytes([
        { kind: 'put', table: 'ledger', item: { pk: PK, sk: SK } },
        {
          kind: 'update',
          table: 'control',
          key: { pk: PK, sk: 'u' },
          set: { state: 'X' },
          increment: { version: 10 },
          condition: { kind: 'item_absent' },
        },
        check({ kind: 'item_absent' }),
      ]),
      // put 6; update: pk 2 + 1, sk 2 + 1, state 5 + 1, version 7 + 2.
      6 + 3 + 3 + 6 + 9,
    );
  });
});
