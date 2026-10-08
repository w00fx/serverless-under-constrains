// Request validation limits added in WP-04 review round 2: DynamoDB's expression, attribute-name
// and transaction limits (Constraints.html), and totality over deep, wide and long input: no
// condition depth or width, no number of refused elements and no attribute-name length may make
// the validator throw, and every message stays bounded (Owner amendment A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Condition, WriteAction } from '../../../src/durable-store/item-store-port.ts';
import { validateTransaction, validateWriteAction } from '../../../src/durable-store/write-action-validation.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';

const TOKEN = '7d1c0fbc-ba4e-4c06-9d65-e566dbdbb434' as Uuid4;

function check(condition: Condition): WriteAction {
  return { kind: 'condition_check', table: 'control', key: { pk: 'p', sk: 's' }, condition };
}

describe('validateWriteAction limits added in WP-04 review round 2', () => {
  // `leaf` wrapped in `depth` single-member `all` conditions, built without recursion.
  function nestedAll(depth: number, leaf: Condition): Condition {
    let condition = leaf;
    for (let level = 0; level < depth; level += 1) {
      condition = { kind: 'all', conditions: [condition] };
    }
    return condition;
  }
  const equalsLeaf: Condition = { kind: 'attribute_equals', name: 'a', value: 1 };

  it('refuses a 100,000-level condition with one violation instead of overflowing the call stack', () => {
    const deep = nestedAll(100_000, { kind: 'item_absent' });
    const nesting =
      'nests all 100000 levels deep; expected at most 2043 (deeper conditions cannot fit the 4 KB DynamoDB expression limit)';
    assert.deepEqual(validateWriteAction(check(deep)), [`action.condition ${nesting}`]);
    assert.deepEqual(
      validateWriteAction({ kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's' }, condition: deep }),
      [`action.condition ${nesting}`],
    );
    assert.deepEqual(validateTransaction([check(deep)], TOKEN), [`actions[0].condition ${nesting}`]);
  });

  it('accepts 2043 levels of all (4095 bytes) and refuses 2044 by the nesting bound', () => {
    assert.deepEqual(validateWriteAction(check(nestedAll(2043, equalsLeaf))), []);
    assert.deepEqual(validateWriteAction(check(nestedAll(2044, equalsLeaf))), [
      'action.condition nests all 2044 levels deep; expected at most 2043 (deeper conditions cannot fit the 4 KB DynamoDB expression limit)',
    ]);
  });

  it('reports nested condition violations depth first, left to right', () => {
    assert.deepEqual(
      validateWriteAction(
        check({
          kind: 'all',
          conditions: [
            {
              kind: 'all',
              conditions: [
                { kind: 'attribute_equals', name: '', value: 1 },
                { kind: 'all', conditions: [] },
              ],
            },
            { kind: 'attribute_in', name: 'b', values: [] },
          ],
        }),
      ),
      [
        'action.condition.conditions[0].conditions[0]: attribute name is ""; expected a non-empty attribute name',
        'action.condition.conditions[0].conditions[1]: all has no conditions; expected at least one',
        'action.condition.conditions[1]: attribute_in has 0 values; expected 1 to 100',
      ],
    );
  });

  it('accepts attribute names of 64 KB and refuses longer ones wherever a name appears', () => {
    const atLimit = 'é'.repeat(32_768);
    const over = `${atLimit}x`;
    const tooLong = 'attribute name is 65537 UTF-8 bytes long; expected at most 65536 bytes (DynamoDB limit)';
    assert.deepEqual(
      validateWriteAction({ kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's', [atLimit]: 1 } }),
      [],
    );
    assert.deepEqual(validateWriteAction({ kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's', [over]: 1 } }), [
      `action: ${tooLong}`,
    ]);
    assert.deepEqual(
      validateWriteAction({
        kind: 'update',
        table: 'control',
        key: { pk: 'p', sk: 's' },
        set: { [over]: 1 },
        increment: { [over.replace('x', 'y')]: 1 },
        condition: { kind: 'item_absent' },
      }),
      [`action: ${tooLong}`, `action: ${tooLong}`],
    );
    assert.deepEqual(validateWriteAction(check({ kind: 'attribute_in', name: over, values: ['v'] })), [
      `action.condition: ${tooLong}`,
    ]);
  });

  it('measures expression limits only once the action is otherwise valid', () => {
    const tooManyOperators: Condition = {
      kind: 'all',
      conditions: Array.from({ length: 151 }, () => equalsLeaf),
    };
    assert.deepEqual(validateWriteAction(check(tooManyOperators)), [
      'action.condition has 301 operators or functions; expected at most 300 (DynamoDB expression limit)',
    ]);
    assert.deepEqual(
      validateWriteAction({
        kind: 'put',
        table: 'ledger',
        item: { pk: 'p', sk: 's', '': 1 },
        condition: tooManyOperators,
      }),
      ['action: attribute name is ""; expected a non-empty attribute name'],
    );
  });

  it('quotes a long attribute name or token through the bounded kernel helper', () => {
    const long = 'n'.repeat(1_000_000);
    assert.deepEqual(
      validateWriteAction({
        kind: 'update',
        table: 'control',
        key: { pk: 'p', sk: 's' },
        set: { [long]: 1 },
        increment: { [long]: 1 },
        condition: { kind: 'item_absent' },
      }).slice(0, 1),
      [`action: attribute "${'n'.repeat(199)}…[truncated] is both set and incremented; expected one clause`],
    );
    assert.deepEqual(validateTransaction([check({ kind: 'item_absent' })], long), [
      `ClientRequestToken is "${'n'.repeat(199)}…[truncated]; expected a lowercase UUIDv4 (36 characters)`,
    ]);
  });
});

describe('validateTransaction limits added in WP-04 review round 2', () => {
  // Ten items at the 400 KB item limit plus one of 98,304 bytes hold exactly 4 MB of data.
  function fourMegabytes(extra: number): readonly WriteAction[] {
    const sortKeys = 'abcdefghij'.split('');
    const full = sortKeys.map((sk): WriteAction => ({
      kind: 'put',
      table: 'ledger',
      item: { pk: 'p', sk, v: 'x'.repeat(409_593) },
    }));
    return [...full, { kind: 'put', table: 'ledger', item: { pk: 'p', sk: 'k', v: 'x'.repeat(98_297 + extra) } }];
  }

  it('accepts exactly 4 MB of item data and refuses one byte more', () => {
    assert.deepEqual(validateTransaction(fourMegabytes(0), TOKEN), []);
    assert.deepEqual(validateTransaction(fourMegabytes(1), TOKEN), [
      'transaction writes about 4194305 bytes of item data; expected at most 4194304 bytes (DynamoDB transaction limit)',
    ]);
  });

  it('compares only valid keys for duplicates, so an invalid key is reported once', () => {
    const emptySk: WriteAction = { kind: 'put', table: 'ledger', item: { pk: 'p', sk: '' } };
    assert.deepEqual(validateTransaction([emptySk, emptySk], TOKEN), [
      'actions[0]: sk is ""; expected a non-empty well-formed string of at most 1024 UTF-8 bytes',
      'actions[1]: sk is ""; expected a non-empty well-formed string of at most 1024 UTF-8 bytes',
    ]);
    const hugeKey: WriteAction = {
      kind: 'condition_check',
      table: 'control',
      key: { pk: 'q'.repeat(3_000_000), sk: 's' },
      condition: { kind: 'item_absent' },
    };
    assert.deepEqual(validateTransaction([hugeKey, hugeKey], TOKEN), [
      'actions[0]: pk is 3000000 UTF-8 bytes long; expected a non-empty well-formed string of at most 2048 UTF-8 bytes',
      'actions[1]: pk is 3000000 UTF-8 bytes long; expected a non-empty well-formed string of at most 2048 UTF-8 bytes',
    ]);
  });
});

describe('validation totality over wide input and long names (WP-04 review round 2)', () => {
  // V8 throws RangeError when one call receives more than about 100,000 spread arguments; the
  // first fix spread condition members and violations into push() and threw at these widths.
  const WIDE = 200_000;
  const operatorLimit = 'has 399999 operators or functions; expected at most 300 (DynamoDB expression limit)';

  it('refuses a 200,000-member all by its operator count, without throwing', () => {
    const wide: Condition = {
      kind: 'all',
      conditions: Array.from({ length: WIDE }, () => ({ kind: 'item_absent' }) as const),
    };
    const violations = validateWriteAction(check(wide));
    assert.equal(violations.length, 2);
    assert.match(violations[0] ?? '', /^action\.condition expression is \d+ bytes long; expected at most 4096 bytes/);
    assert.equal(violations[1], `action.condition ${operatorLimit}`);
    assert.equal(validateTransaction([check(wide)], TOKEN)[1], `actions[0].condition ${operatorLimit}`);
  });

  it('lists every invalid member of a 200,000-member all, in order', () => {
    const wide: Condition = {
      kind: 'all',
      conditions: Array.from({ length: WIDE }, () => ({ kind: 'attribute_in', name: 'a', values: [] }) as const),
    };
    const violations = validateWriteAction(check(wide));
    assert.equal(violations.length, WIDE);
    assert.equal(violations[0], 'action.condition.conditions[0]: attribute_in has 0 values; expected 1 to 100');
    assert.equal(
      violations.at(-1),
      'action.condition.conditions[199999]: attribute_in has 0 values; expected 1 to 100',
    );
  });

  it('lists 200,000 refused list elements of a put, an update and a transaction without throwing', () => {
    const nans: readonly number[] = Array.from({ length: WIDE }, () => Number.NaN);
    const nanShape =
      'NaN is not a finite number; expected a finite number, safe when integral, zero or of magnitude at least 1E-130';
    const put: WriteAction = { kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's', v: nans } };
    const update: WriteAction = {
      kind: 'update',
      table: 'control',
      key: { pk: 'p', sk: 's' },
      set: { v: nans },
      condition: { kind: 'item_absent' },
    };
    // Each element is refused, and the 200,000 numbers also push the item past 400 KB.
    for (const [action, path] of [
      [put, 'action.item.v'],
      [update, 'action.set.v'],
    ] as const) {
      const violations = validateWriteAction(action);
      assert.equal(violations.length, WIDE + 1);
      assert.equal(violations[0], `${path}[0]: ${nanShape}`);
      assert.equal(violations[WIDE - 1], `${path}[199999]: ${nanShape}`);
    }
    const transaction = validateTransaction([put], TOKEN);
    assert.equal(transaction.length, WIDE + 1);
    assert.equal(transaction[0], `actions[0].item.v[0]: ${nanShape}`);
  });

  it('keeps a violation short however long the attribute name in its path is', () => {
    const long = 'n'.repeat(1_000_000);
    const quoted = `"${'n'.repeat(199)}…[truncated]`;
    const nanShape =
      'NaN is not a finite number; expected a finite number, safe when integral, zero or of magnitude at least 1E-130';
    // A nested name of 300,000 bytes keeps the item under 400 KB, so the NaN is the one refusal.
    const nested = 'n'.repeat(300_000);
    assert.deepEqual(
      validateWriteAction({ kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's', a: { [nested]: Number.NaN } } }),
      [`action.item.a.${quoted}: ${nanShape}`],
    );
    const update = validateWriteAction({
      kind: 'update',
      table: 'control',
      key: { pk: 'p', sk: 's' },
      set: { [long]: Number.NaN },
      increment: { [`${long}x`]: 0.5 },
      condition: { kind: 'item_absent' },
    });
    assert.ok(update.length > 0);
    for (const violation of update) {
      assert.ok(violation.length < 500, violation.slice(0, 300));
    }
    assert.ok(update.includes(`action.set.${quoted}: ${nanShape}`), update.join('\n').slice(0, 600));
    assert.ok(
      update.includes(`action.increment.${quoted}: 0.5 is not a safe integer; expected a safe integer increment`),
      update.join('\n').slice(0, 600),
    );
  });
});
