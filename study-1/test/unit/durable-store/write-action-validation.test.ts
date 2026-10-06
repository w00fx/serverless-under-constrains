// Request validation shared by the DynamoDB adapter and the emulator: DynamoDB's documented
// rejections, each with the offending value and the expected shape.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Condition, WriteAction } from '../../../src/durable-store/item-store-port.ts';
import {
  itemIdentity,
  keyViolations,
  MAX_IN_OPERANDS,
  MAX_TRANSACTION_ACTIONS,
  partitionKeyViolations,
  validateTransaction,
  validateWriteAction,
} from '../../../src/durable-store/write-action-validation.ts';
import type { JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';

const TOKEN = '7d1c0fbc-ba4e-4c06-9d65-e566dbdbb434' as Uuid4;

function check(condition: Condition): WriteAction {
  return { kind: 'condition_check', table: 'control', key: { pk: 'p', sk: 's' }, condition };
}

describe('validateWriteAction', () => {
  it('accepts well-formed put, update and condition_check actions', () => {
    assert.deepEqual(
      validateWriteAction({ kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's', amount_minor: 10000, x: [1.5] } }),
      [],
    );
    assert.deepEqual(
      validateWriteAction({
        kind: 'put',
        table: 'ledger',
        item: { pk: 'p', sk: 's' },
        condition: { kind: 'item_absent' },
      }),
      [],
    );
    assert.deepEqual(
      validateWriteAction({
        kind: 'update',
        table: 'control',
        key: { pk: 'p', sk: 'treatment' },
        set: { state: 'X', nested: { n: 1 } },
        increment: { version: 1 },
        condition: { kind: 'attribute_equals', name: 'version', value: 3 },
      }),
      [],
    );
    assert.deepEqual(validateWriteAction(check({ kind: 'attribute_in', name: 'a', values: ['x'] })), []);
  });

  it('rejects empty and oversized keys at the documented byte limits', () => {
    assert.deepEqual(keyViolations({ pk: '', sk: '' }, 'get'), [
      'get: pk is ""; expected a non-empty well-formed string of at most 2048 UTF-8 bytes',
      'get: sk is ""; expected a non-empty well-formed string of at most 1024 UTF-8 bytes',
    ]);
    assert.deepEqual(keyViolations({ pk: 'é'.repeat(1024), sk: 'x'.repeat(1024) }, 'get'), []);
    assert.deepEqual(keyViolations({ pk: `${'é'.repeat(1024)}x`, sk: `${'x'.repeat(1024)}y` }, 'get'), [
      'get: pk is 2049 UTF-8 bytes long; expected a non-empty well-formed string of at most 2048 UTF-8 bytes',
      'get: sk is 1025 UTF-8 bytes long; expected a non-empty well-formed string of at most 1024 UTF-8 bytes',
    ]);
    assert.deepEqual(partitionKeyViolations('', 'query'), [
      'query: pk is ""; expected a non-empty well-formed string of at most 2048 UTF-8 bytes',
    ]);
    assert.deepEqual(partitionKeyViolations('p', 'query'), []);
    assert.deepEqual(keyViolations({ pk: 'a\uD800', sk: '\uDC00b' }, 'get'), [
      'get: pk is "a\\ud800"; expected a non-empty well-formed string of at most 2048 UTF-8 bytes',
      'get: sk is "\\udc00b"; expected a non-empty well-formed string of at most 1024 UTF-8 bytes',
    ]);
  });

  it('rejects a put with an empty attribute name or an unencodable number anywhere in the item', () => {
    assert.deepEqual(
      validateWriteAction({
        kind: 'put',
        table: 'ledger',
        item: { pk: 'p', sk: 's', '': 1, deep: { list: [1, Number.NaN] }, big: 2 ** 53 },
      }),
      [
        'action: attribute name is ""; expected a non-empty attribute name',
        'action.item.deep.list[1]: NaN is not a finite number; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
        'action.item.big: 9007199254740992 is an integer outside the safe-integer range; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
      ],
    );
  });

  it('rejects an update that changes nothing, touches a key, or both sets and increments an attribute', () => {
    const base = {
      kind: 'update',
      table: 'control',
      key: { pk: 'p', sk: 's' },
      condition: { kind: 'item_absent' },
    } as const;
    assert.deepEqual(validateWriteAction({ ...base, set: {} }), [
      'action: update sets and increments nothing; expected at least one attribute',
    ]);
    assert.deepEqual(validateWriteAction({ ...base, set: { pk: 'x' }, increment: { sk: 1 } }), [
      'action: update changes key attribute "pk"; expected non-key attributes',
      'action: update changes key attribute "sk"; expected non-key attributes',
    ]);
    assert.deepEqual(validateWriteAction({ ...base, set: { v: 1, w: 2 }, increment: { v: 1 } }), [
      'action: attribute "v" is both set and incremented; expected one clause',
    ]);
    assert.deepEqual(
      validateWriteAction({ ...base, set: { '': 1, n: Number.NaN }, increment: { c: Number.POSITIVE_INFINITY } }),
      [
        'action: attribute name is ""; expected a non-empty attribute name',
        'action.set.n: NaN is not a finite number; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
        'action.increment.c: Infinity is not a safe integer; expected a safe integer increment',
      ],
    );
  });

  it('rejects malformed conditions at every depth', () => {
    assert.deepEqual(validateWriteAction(check({ kind: 'attribute_equals', name: '', value: Number.NaN })), [
      'action.condition: attribute name is ""; expected a non-empty attribute name',
      'action.condition.value: NaN is not a finite number; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
    ]);
    assert.deepEqual(validateWriteAction(check({ kind: 'attribute_equals', name: 'a', value: 'NaN' })), []);
    assert.deepEqual(validateWriteAction(check({ kind: 'attribute_in', name: 'a', values: [] })), [
      'action.condition: attribute_in has 0 values; expected 1 to 100',
    ]);
    const atLimit = Array.from({ length: MAX_IN_OPERANDS }, (_, index) => String(index));
    assert.deepEqual(validateWriteAction(check({ kind: 'attribute_in', name: 'a', values: atLimit })), []);
    assert.deepEqual(validateWriteAction(check({ kind: 'attribute_in', name: '', values: [...atLimit, 'x'] })), [
      'action.condition: attribute name is ""; expected a non-empty attribute name',
      'action.condition: attribute_in has 101 values; expected 1 to 100',
    ]);
    assert.deepEqual(validateWriteAction(check({ kind: 'all', conditions: [] })), [
      'action.condition: all has no conditions; expected at least one',
    ]);
    assert.deepEqual(
      validateWriteAction(
        check({
          kind: 'all',
          conditions: [
            { kind: 'item_absent' },
            { kind: 'all', conditions: [{ kind: 'attribute_in', name: 'z', values: [] }] },
          ],
        }),
      ),
      ['action.condition.conditions[1].conditions[0]: attribute_in has 0 values; expected 1 to 100'],
    );
  });

  it('validates the key and condition of a put and a condition_check', () => {
    assert.deepEqual(
      validateWriteAction({
        kind: 'put',
        table: 'ledger',
        item: { pk: '', sk: 's' },
        condition: { kind: 'all', conditions: [] },
      }),
      [
        'action: pk is ""; expected a non-empty well-formed string of at most 2048 UTF-8 bytes',
        'action.condition: all has no conditions; expected at least one',
      ],
    );
    assert.deepEqual(
      validateWriteAction({
        kind: 'update',
        table: 'ledger',
        key: { pk: 'p', sk: '' },
        set: { a: 1 },
        condition: { kind: 'all', conditions: [] },
      }),
      [
        'action: sk is ""; expected a non-empty well-formed string of at most 1024 UTF-8 bytes',
        'action.condition: all has no conditions; expected at least one',
      ],
    );
  });
});

describe('validateWriteAction DynamoDB value limits (WP-04 review round 1)', () => {
  // A list nested `depth` levels around the number 1, built without recursion.
  function nestedList(depth: number): JsonValue {
    let value: JsonValue = 1;
    for (let level = 0; level < depth; level += 1) {
      value = [value];
    }
    return value;
  }

  it('accepts 32 levels of nesting and refuses the 33rd, naming its path', () => {
    const put = (value: JsonValue): WriteAction => ({
      kind: 'put',
      table: 'ledger',
      item: { pk: 'p', sk: 's', v: value },
    });
    assert.deepEqual(validateWriteAction(put(nestedList(32))), []);
    assert.deepEqual(validateWriteAction(put(nestedList(33))), [
      `action.item.v${'[0]'.repeat(32)} nests deeper than 32 levels; expected at most 32 levels of lists and maps (DynamoDB limit)`,
    ]);
  });

  it('refuses a deep value with a violation instead of overflowing the call stack', () => {
    const deep = nestedList(20_000);
    const violation = `nests deeper than 32 levels; expected at most 32 levels of lists and maps (DynamoDB limit)`;
    assert.deepEqual(validateWriteAction({ kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's', v: deep } }), [
      `action.item.v${'[0]'.repeat(32)} ${violation}`,
    ]);
    assert.deepEqual(
      validateWriteAction({
        kind: 'update',
        table: 'control',
        key: { pk: 'p', sk: 's' },
        set: { v: deep },
        condition: { kind: 'item_absent' },
      }),
      [`action.set.v${'[0]'.repeat(32)} ${violation}`],
    );
  });

  it('refuses an item over 400 KB and accepts one at the limit', () => {
    // Names pk, sk and v (5 bytes) plus values p and s (2 bytes) leave 409593 bytes for v.
    const fits = 'x'.repeat(409_593);
    assert.deepEqual(validateWriteAction({ kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's', v: fits } }), []);
    assert.deepEqual(validateWriteAction({ kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's', v: `${fits}x` } }), [
      'action.item is about 409601 bytes; expected at most 409600 bytes (DynamoDB item size limit)',
    ]);
    assert.deepEqual(
      validateWriteAction({
        kind: 'update',
        table: 'control',
        key: { pk: 'p', sk: 's' },
        set: { v: `${fits}x` },
        condition: { kind: 'item_absent' },
      }),
      ['action.set is about 409601 bytes; expected at most 409600 bytes (DynamoDB item size limit)'],
    );
  });

  it('refuses numbers below the smallest DynamoDB magnitude anywhere in a value or condition', () => {
    assert.deepEqual(
      validateWriteAction({ kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's', tiny: [1e-131], zero: 0 } }),
      [
        'action.item.tiny[0]: 1e-131 is nonzero with a magnitude below 1E-130; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
      ],
    );
    assert.deepEqual(validateWriteAction(check({ kind: 'attribute_equals', name: 'a', value: 5e-324 })), [
      'action.condition.value: 5e-324 is nonzero with a magnitude below 1E-130; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
    ]);
  });

  it('accepts only safe-integer increments', () => {
    const update = (amount: number): WriteAction => ({
      kind: 'update',
      table: 'control',
      key: { pk: 'p', sk: 's' },
      set: {},
      increment: { n: amount },
      condition: { kind: 'item_absent' },
    });
    assert.deepEqual(validateWriteAction(update(-3)), []);
    assert.deepEqual(validateWriteAction(update(Number.MAX_SAFE_INTEGER)), []);
    assert.deepEqual(validateWriteAction(update(0.2)), [
      'action.increment.n: 0.2 is not a safe integer; expected a safe integer increment',
    ]);
    assert.deepEqual(validateWriteAction(update(2 ** 53)), [
      'action.increment.n: 9007199254740992 is not a safe integer; expected a safe integer increment',
    ]);
  });
});

describe('validateTransaction', () => {
  const put = (sk: string): WriteAction => ({ kind: 'put', table: 'ledger', item: { pk: 'p', sk } });

  it('accepts 1 to 100 actions on distinct items with a UUIDv4 token', () => {
    assert.deepEqual(validateTransaction([put('a')], TOKEN), []);
    const hundred = Array.from({ length: MAX_TRANSACTION_ACTIONS }, (_, index) => put(String(index)));
    assert.deepEqual(validateTransaction(hundred, TOKEN), []);
  });

  it('rejects an empty or oversized transaction and a token that is not a lowercase UUIDv4', () => {
    assert.deepEqual(validateTransaction([], 'not-a-token'), [
      'transaction has 0 actions; expected 1 to 100',
      'ClientRequestToken is "not-a-token"; expected a lowercase UUIDv4 (36 characters)',
    ]);
    const tooMany = Array.from({ length: MAX_TRANSACTION_ACTIONS + 1 }, (_, index) => put(String(index)));
    assert.deepEqual(validateTransaction(tooMany, TOKEN.toUpperCase()), [
      'transaction has 101 actions; expected 1 to 100',
      'ClientRequestToken is "7D1C0FBC-BA4E-4C06-9D65-E566DBDBB434"; expected a lowercase UUIDv4 (36 characters)',
    ]);
  });

  it('rejects two actions on the same item, and locates action violations by index', () => {
    const sameItemOtherTable: WriteAction = { ...put('a'), table: 'control' };
    assert.deepEqual(
      validateTransaction(
        [
          put('a'),
          sameItemOtherTable,
          { kind: 'condition_check', table: 'ledger', key: { pk: 'p', sk: 'a' }, condition: { kind: 'item_absent' } },
          put(''),
        ],
        TOKEN,
      ),
      [
        'actions[2] targets the same item as actions[0]: ledger "p" "a"',
        'actions[3]: sk is ""; expected a non-empty well-formed string of at most 1024 UTF-8 bytes',
      ],
    );
  });
});

describe('itemIdentity', () => {
  it('names table and JSON-quoted keys so separators inside keys cannot collide', () => {
    assert.equal(itemIdentity({ kind: 'put', table: 'ledger', item: { pk: 'a b', sk: 'c' } }), 'ledger "a b" "c"');
    assert.equal(
      itemIdentity({
        kind: 'condition_check',
        table: 'control',
        key: { pk: 'a', sk: 'b c' },
        condition: { kind: 'item_absent' },
      }),
      'control "a" "b c"',
    );
  });
});
