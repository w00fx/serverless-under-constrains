// Conformance of InMemoryItemStore with the DynamoDB behavior it emulates (design §12.2, RK-17):
// conditional writes, transactions and partition queries. Sources: API_PutItem, API_UpdateItem,
// API_TransactWriteItems (F-1 token window and IdempotentParameterMismatch), API_Query and
// Query.Pagination ([R-aws] §1.1-§1.3), HowItWorks.NamingRulesDataTypes (UTF-8 byte order and
// the number range), Constraints.html (32 nesting levels), ServiceQuotas.html and
// CapacityUnitCalculations.html (400 KB item size).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Condition, WriteAction, WriteOutcome } from '../../../../src/durable-store/item-store-port.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { decodePageCursor, encodePageCursor } from '../../../../src/durable-store/page-cursor.ts';
import { IDEMPOTENCY_WINDOW_MS, InMemoryItemStore } from '../../../support/durable-store/in-memory-item-store.ts';
import {
  ARMED,
  COMMIT_TREATMENT,
  failedOn,
  OTHER_TOKEN,
  PK,
  putAction,
  storeHarness,
  TOKEN,
} from '../../../support/durable-store/item-store-fixtures.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';

describe('InMemoryItemStore conditional writes', () => {
  it('a conditional put on an existing item fails with the old item (ALL_OLD) and changes nothing', async () => {
    const { store } = storeHarness();
    const first = { pk: PK, sk: 'tx#1', amount_minor: 10000 };
    assert.deepEqual(await store.write(putAction('ledger', first, { kind: 'item_absent' })), { kind: 'applied' });
    assert.deepEqual(await store.write(putAction('ledger', { ...first, amount_minor: 1 }, { kind: 'item_absent' })), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: first,
    });
    assert.deepEqual(await store.getConsistent('ledger', { pk: PK, sk: 'tx#1' }), { ok: true, value: first });
  });

  it('an unconditional put replaces the whole item', async () => {
    const { store } = storeHarness();
    store.seed('control', { pk: PK, sk: 'c', a: 1, b: 2 });
    assert.deepEqual(await store.write(putAction('control', { pk: PK, sk: 'c', a: 3 })), { kind: 'applied' });
    assert.deepEqual(store.peek('control', { pk: PK, sk: 'c' }), { pk: PK, sk: 'c', a: 3 });
  });

  it('comparisons are typed and false on a missing attribute or item', async () => {
    const { store } = storeHarness();
    const seeded = { pk: PK, sk: 'c', n: 1, s: '1', flag: true };
    store.seed('control', seeded);
    const cases: readonly [Condition, string, WriteOutcome][] = [
      [{ kind: 'attribute_equals', name: 'n', value: 1 }, 'c', { kind: 'applied' }],
      [{ kind: 'attribute_equals', name: 'flag', value: true }, 'c', { kind: 'applied' }],
      [{ kind: 'attribute_equals', name: 'n', value: '1' }, 'c', failedOn(seeded)],
      [{ kind: 'attribute_equals', name: 's', value: 1 }, 'c', failedOn(seeded)],
      [{ kind: 'attribute_equals', name: 'gone', value: 1 }, 'c', failedOn(seeded)],
      [{ kind: 'attribute_equals', name: 'toString', value: 'x' }, 'c', failedOn(seeded)],
      [{ kind: 'attribute_in', name: 's', values: ['0', '1'] }, 'c', { kind: 'applied' }],
      [{ kind: 'attribute_in', name: 'n', values: ['1'] }, 'c', failedOn(seeded)],
      [
        { kind: 'attribute_equals', name: 'n', value: 1 },
        'missing',
        { kind: 'condition_failed', failed_action_index: 0 },
      ],
      [{ kind: 'all', conditions: [{ kind: 'item_absent' }] }, 'missing', { kind: 'applied' }],
      [
        {
          kind: 'all',
          conditions: [
            { kind: 'attribute_equals', name: 'n', value: 1 },
            { kind: 'attribute_in', name: 's', values: ['1'] },
          ],
        },
        'c',
        { kind: 'applied' },
      ],
    ];
    for (const [condition, sk, expected] of cases) {
      const outcome = await store.write({ kind: 'condition_check', table: 'control', key: { pk: PK, sk }, condition });
      assert.deepEqual(outcome, expected, JSON.stringify(condition));
    }
  });

  it('an update creates the item when its condition admits a missing item, and ADD starts at zero', async () => {
    const { store } = storeHarness();
    const create: WriteAction = {
      kind: 'update',
      table: 'coordination',
      key: { pk: 'lease', sk: 'lease' },
      set: { owner_id: 'me' },
      increment: { lease_version: 1 },
      condition: { kind: 'item_absent' },
    };
    assert.deepEqual(await store.write(create), { kind: 'applied' });
    assert.deepEqual(store.peek('coordination', { pk: 'lease', sk: 'lease' }), {
      pk: 'lease',
      sk: 'lease',
      owner_id: 'me',
      lease_version: 1,
    });
  });

  it('an update keeps other attributes, sets and increments, and fails its condition on a missing item', async () => {
    const { store } = storeHarness();
    assert.deepEqual(await store.write(COMMIT_TREATMENT), { kind: 'condition_failed', failed_action_index: 0 });
    store.seed('control', { ...ARMED, extra: 'kept' });
    assert.deepEqual(await store.write(COMMIT_TREATMENT), { kind: 'applied' });
    assert.deepEqual(store.peek('control', { pk: PK, sk: 'treatment' }), {
      pk: PK,
      sk: 'treatment',
      state: 'COMMITTED_WAITING',
      version: 2,
      extra: 'kept',
    });
  });

  it('ADD on a non-number is rejected: ValidationException alone, ValidationError in a transaction', async () => {
    const { store } = storeHarness();
    store.seed('control', { pk: PK, sk: 'treatment', state: 'ARMED', version: 'one' });
    assert.deepEqual(await store.write(COMMIT_TREATMENT), { kind: 'definitive_failure', code: 'ValidationException' });
    assert.deepEqual(await store.transact([COMMIT_TREATMENT], TOKEN), {
      kind: 'definitive_failure',
      code: 'ValidationError',
    });
    assert.equal(store.peek('control', { pk: PK, sk: 'treatment' })?.['state'], 'ARMED');
  });

  it('refuses invalid requests with ValidationException and applies nothing', async () => {
    const { store } = storeHarness();
    assert.deepEqual(await store.write(putAction('ledger', { pk: '', sk: 's' })), {
      kind: 'definitive_failure',
      code: 'ValidationException',
    });
    assert.deepEqual(await store.getConsistent('ledger', { pk: PK, sk: '' }), {
      ok: false,
      error: { code: 'ValidationException' },
    });
    assert.deepEqual(await store.queryPartitionPage('ledger', ''), {
      ok: false,
      error: { code: 'ValidationException' },
    });
    assert.deepEqual(store.itemsIn('ledger'), []);
  });

  it('hands out copies, so a caller cannot change stored state', async () => {
    const { store } = storeHarness();
    const item = { pk: PK, sk: 'c', list: [1] };
    await store.write(putAction('control', item));
    item.list.push(2);
    const read = await store.getConsistent('control', { pk: PK, sk: 'c' });
    assert.ok(read.ok && read.value !== undefined);
    (read.value['list'] as number[]).push(3);
    assert.deepEqual(store.peek('control', { pk: PK, sk: 'c' })?.['list'], [1]);
  });
});

describe('InMemoryItemStore transactions', () => {
  const ledger = putAction('ledger', { pk: PK, sk: 'tx#1', amount_minor: 10000 }, { kind: 'item_absent' });

  it('is all-or-nothing and reports the first failing action with its old item', async () => {
    const { store } = storeHarness();
    store.seed('control', { ...ARMED, state: 'CONSUMED' });
    assert.deepEqual(await store.transact([ledger, COMMIT_TREATMENT], TOKEN), {
      kind: 'condition_failed',
      failed_action_index: 1,
      existing: { ...ARMED, state: 'CONSUMED' },
    });
    assert.deepEqual(store.itemsIn('ledger'), []);
  });

  it('rejects two actions on the same item without applying either', async () => {
    const { store } = storeHarness();
    assert.deepEqual(await store.transact([ledger, { ...ledger, condition: { kind: 'item_absent' } }], TOKEN), {
      kind: 'definitive_failure',
      code: 'ValidationException',
    });
    assert.deepEqual(store.itemsIn('ledger'), []);
  });

  it('a token replay with identical actions inside 10 minutes succeeds without re-applying (F-1)', async () => {
    const { store, time } = storeHarness();
    store.seed('control', ARMED);
    assert.deepEqual(await store.transact([ledger, COMMIT_TREATMENT], TOKEN), { kind: 'applied' });
    await time.advanceBy(IDEMPOTENCY_WINDOW_MS - 1);
    assert.deepEqual(await store.transact([ledger, COMMIT_TREATMENT], TOKEN), { kind: 'applied' });
    assert.equal(store.peek('control', { pk: PK, sk: 'treatment' })?.['version'], 2);
  });

  it('a token replay with changed actions fails with IdempotentParameterMismatchException (F-1)', async () => {
    const { store } = storeHarness();
    store.seed('control', ARMED);
    assert.deepEqual(await store.transact([ledger, COMMIT_TREATMENT], TOKEN), { kind: 'applied' });
    assert.deepEqual(await store.transact([ledger], TOKEN), {
      kind: 'definitive_failure',
      code: 'IdempotentParameterMismatchException',
    });
  });

  it('a token is forgotten 10 minutes after completion, so the replay executes again', async () => {
    const { store, time } = storeHarness();
    assert.deepEqual(await store.transact([ledger], TOKEN), { kind: 'applied' });
    await time.advanceBy(IDEMPOTENCY_WINDOW_MS);
    assert.deepEqual(await store.transact([ledger], TOKEN), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: { pk: PK, sk: 'tx#1', amount_minor: 10000 },
    });
    assert.deepEqual(await store.transact([putAction('ledger', { pk: PK, sk: 'tx#2' })], TOKEN), { kind: 'applied' });
  });

  it('a cancelled transaction does not register its token', async () => {
    const { store } = storeHarness();
    assert.deepEqual(await store.transact([COMMIT_TREATMENT], TOKEN), {
      kind: 'condition_failed',
      failed_action_index: 0,
    });
    store.seed('control', ARMED);
    assert.deepEqual(await store.transact([COMMIT_TREATMENT], TOKEN), { kind: 'applied' });
    assert.equal(store.peek('control', { pk: PK, sk: 'treatment' })?.['version'], 2);
    assert.deepEqual(await store.transact([COMMIT_TREATMENT], OTHER_TOKEN), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: { pk: PK, sk: 'treatment', state: 'COMMITTED_WAITING', version: 2 },
    });
  });
});

describe('InMemoryItemStore partition queries', () => {
  it('returns one partition in UTF-8 byte order of the sort key', async () => {
    const { store } = storeHarness();
    for (const sk of ['b', '\u{1F600}', '￿', 'B', 'a']) {
      store.seed('ledger', { pk: PK, sk });
    }
    store.seed('ledger', { pk: 'other', sk: 'a' });
    const page = await store.queryPartitionPage('ledger', PK);
    assert.ok(page.ok);
    assert.deepEqual(
      page.value.items.map((item) => item.sk),
      ['B', 'a', 'b', '￿', '\u{1F600}'],
    );
    assert.equal(page.value.next_cursor, undefined);
    assert.equal(page.value.consistent_read, true);
  });

  it('pages by page size; a full page carries a cursor even when nothing remains', async () => {
    const { store } = storeHarness(2);
    for (const sk of ['a', 'b', 'c', 'd']) {
      store.seed('ledger', { pk: PK, sk });
    }
    const sks: string[] = [];
    const cursors: (string | undefined)[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.queryPartitionPage('ledger', PK, cursor);
      assert.ok(page.ok);
      sks.push(...page.value.items.map((item) => item.sk));
      cursor = page.value.next_cursor;
      cursors.push(cursor);
    } while (cursor !== undefined);
    assert.deepEqual(sks, ['a', 'b', 'c', 'd']);
    assert.deepEqual(cursors, [
      encodePageCursor({ pk: PK, sk: 'b' }),
      encodePageCursor({ pk: PK, sk: 'd' }),
      undefined,
    ]);
    store.setPageSize(5);
    const all = await store.queryPartitionPage('ledger', PK);
    assert.equal(all.ok && all.value.items.length, 4);
  });

  it('refuses a cursor of another partition or a malformed one', async () => {
    const { store } = storeHarness();
    const foreign = encodePageCursor({ pk: 'other', sk: 'a' });
    assert.equal(decodePageCursor(foreign, 'other').ok, true);
    assert.deepEqual(await store.queryPartitionPage('ledger', PK, foreign), {
      ok: false,
      error: { code: 'InvalidCursor' },
    });
    assert.deepEqual(await store.queryPartitionPage('ledger', PK, '***'), {
      ok: false,
      error: { code: 'InvalidCursor' },
    });
  });

  it('an empty partition is one empty final page', async () => {
    const { store } = storeHarness();
    assert.deepEqual(await store.queryPartitionPage('ledger', PK), {
      ok: true,
      value: { items: [], consistent_read: true },
    });
  });

  it('refuses a page size that is not a positive integer', () => {
    const { store } = storeHarness();
    assert.throws(() => {
      store.setPageSize(0);
    }, /page size 0; expected a positive safe integer/);
    assert.throws(() => new InMemoryItemStore({ clock: new VirtualTimeScheduler({ wallEpochMs: 0 }), pageSize: 1.5 }), {
      message: 'page size 1.5; expected a positive safe integer',
    });
  });
});

describe('InMemoryItemStore DynamoDB value limits (WP-04 review round 1)', () => {
  function nestedList(depth: number): JsonValue {
    let value: JsonValue = 1;
    for (let level = 0; level < depth; level += 1) {
      value = [value];
    }
    return value;
  }
  const refused: WriteOutcome = { kind: 'definitive_failure', code: 'ValidationException' };

  it('refuses what DynamoDB refuses: 33 nesting levels, an item over 400 KB, a number below 1E-130', async () => {
    const { store } = storeHarness();
    assert.deepEqual(await store.write(putAction('ledger', { pk: PK, sk: 'a', v: nestedList(32) })), {
      kind: 'applied',
    });
    assert.deepEqual(await store.write(putAction('ledger', { pk: PK, sk: 'b', v: nestedList(33) })), refused);
    assert.deepEqual(await store.write(putAction('ledger', { pk: PK, sk: 'c', v: 'x'.repeat(409_600) })), refused);
    assert.deepEqual(await store.write(putAction('ledger', { pk: PK, sk: 'd', v: 1e-131 })), refused);
    assert.deepEqual(await store.write(putAction('ledger', { pk: PK, sk: 'e', v: 5e-324 })), refused);
    assert.deepEqual(
      store.itemsIn('ledger').map((item) => item.sk),
      ['a'],
    );
  });

  it('refuses a 20,000-level value with an outcome instead of throwing', async () => {
    const { store } = storeHarness();
    const deep = putAction('ledger', { pk: PK, sk: 'deep', v: nestedList(20_000) });
    assert.deepEqual(await store.write(deep), refused);
    assert.deepEqual(await store.transact([deep], TOKEN), refused);
  });

  it('refuses an update whose result grows past 400 KB: ValidationException alone, ValidationError in a transaction', async () => {
    const { store } = storeHarness();
    const half = 'x'.repeat(250_000);
    store.seed('control', { pk: PK, sk: 'big', a: half });
    const grow: WriteAction = {
      kind: 'update',
      table: 'control',
      key: { pk: PK, sk: 'big' },
      set: { b: half },
      condition: { kind: 'attribute_equals', name: 'a', value: half },
    };
    assert.deepEqual(await store.write(grow), refused);
    assert.deepEqual(await store.transact([grow], TOKEN), { kind: 'definitive_failure', code: 'ValidationError' });
    assert.deepEqual(store.peek('control', { pk: PK, sk: 'big' }), { pk: PK, sk: 'big', a: half });
  });

  it('a failed condition outranks an earlier refused action, like classifyDynamoError', async () => {
    const { store } = storeHarness();
    store.seed('control', { pk: PK, sk: 'treatment', state: 'ARMED', version: 'one' });
    store.seed('control', { pk: PK, sk: 'other', state: 'CONSUMED' });
    const otherCheck: WriteAction = {
      kind: 'condition_check',
      table: 'control',
      key: { pk: PK, sk: 'other' },
      condition: { kind: 'attribute_equals', name: 'state', value: 'ARMED' },
    };
    assert.deepEqual(await store.transact([COMMIT_TREATMENT, otherCheck], TOKEN), {
      kind: 'condition_failed',
      failed_action_index: 1,
      existing: { pk: PK, sk: 'other', state: 'CONSUMED' },
    });
    assert.equal(store.peek('control', { pk: PK, sk: 'treatment' })?.['state'], 'ARMED');
  });

  it('refuses a forged cursor with an empty sort key and a deeply nested one, as the adapter does', async () => {
    const { store } = storeHarness();
    store.seed('ledger', { pk: PK, sk: 'a' });
    const base64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
    const invalid = { ok: false, error: { code: 'InvalidCursor' } };
    assert.deepEqual(await store.queryPartitionPage('ledger', PK, base64url(`{"pk":"${PK}","sk":""}`)), invalid);
    const deep = base64url(`{"pk":"${PK}","sk":"a","x":${'['.repeat(100_000)}${']'.repeat(100_000)}}`);
    assert.deepEqual(await store.queryPartitionPage('ledger', PK, deep), invalid);
  });
});
