// Conformance of InMemoryItemStore with the DynamoDB request limits added in WP-04 review
// round 2 (design §12.2, RK-17). Source: Constraints.html, sections "Expression parameters",
// "Attribute names" and "DynamoDB transactions" (retrieved 2026-10-05): the service refuses each
// case with a ValidationException and applies nothing, so the emulator must too. Also the
// documented ADD-overflow divergence with a subscribed StreamFeed, and hostile cursors.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DynamoDBRecord } from 'aws-lambda';
import fc from 'fast-check';

import type { Condition, WriteAction, WriteOutcome } from '../../../../src/durable-store/item-store-port.ts';
import { encodePageCursor } from '../../../../src/durable-store/page-cursor.ts';
import { validateWriteAction } from '../../../../src/durable-store/write-action-validation.ts';
import { hostileWriteAction } from '../../../support/durable-store/arbitraries.ts';
import { PK, putAction, storeHarness, TOKEN } from '../../../support/durable-store/item-store-fixtures.ts';
import { StreamFeed } from '../../../support/durable-store/stream-feed.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';

describe('InMemoryItemStore expression and transaction limits (WP-04 review round 2)', () => {
  // Constraints.html, "Expression parameters", "Attribute names" and "DynamoDB transactions":
  // the service refuses each of these with a ValidationException and applies nothing.
  const refused: WriteOutcome = { kind: 'definitive_failure', code: 'ValidationException' };

  function nestedAll(depth: number, leaf: Condition): Condition {
    let condition = leaf;
    for (let level = 0; level < depth; level += 1) {
      condition = { kind: 'all', conditions: [condition] };
    }
    return condition;
  }

  it('refuses an expression over 4 KB or 300 operators, a 64 KB+ name and 2 MB+ of substitutions', async () => {
    const { store } = storeHarness();
    const item = { pk: PK, sk: 'x' };
    const cases: readonly WriteAction[] = [
      putAction('ledger', item, nestedAll(2042, { kind: 'attribute_in', name: 'a', values: ['x', 'y'] })),
      putAction('ledger', item, {
        kind: 'all',
        conditions: Array.from({ length: 151 }, () => ({ kind: 'item_absent' }) as const),
      }),
      {
        kind: 'update',
        table: 'control',
        key: { pk: PK, sk: 'u' },
        set: Object.fromEntries(Array.from({ length: 288 }, (_, index) => [`a${String(index)}`, 1])),
        condition: { kind: 'item_absent' },
      },
      putAction('ledger', { ...item, ['n'.repeat(65_537)]: 1 }),
      putAction('ledger', item, {
        kind: 'attribute_in',
        name: 'a',
        values: Array.from({ length: 100 }, () => 'v'.repeat(21_000)),
      }),
    ];
    for (const action of cases) {
      assert.deepEqual(await store.write(action), refused);
      assert.deepEqual(await store.transact([action], TOKEN), refused);
    }
    assert.deepEqual(store.itemsIn('ledger'), []);
    assert.deepEqual(store.itemsIn('control'), []);
  });

  it('refuses a transaction over 4 MB of item data and applies exactly 4 MB', async () => {
    const { store } = storeHarness();
    const transaction = (prefix: string, extra: number): readonly WriteAction[] => [
      ...'abcdefghij'
        .split('')
        .map((sk) => putAction('ledger', { pk: 'p', sk: `${prefix}${sk}`, v: 'x'.repeat(409_593 - prefix.length) })),
      putAction('ledger', { pk: 'p', sk: `${prefix}k`, v: 'x'.repeat(98_297 - prefix.length + extra) }),
    ];
    assert.deepEqual(await store.transact(transaction('', 1), TOKEN), refused);
    assert.deepEqual(store.itemsIn('ledger'), []);
    assert.deepEqual(await store.transact(transaction('', 0), TOKEN), { kind: 'applied' });
    assert.equal(store.itemsIn('ledger').length, 11);
  });

  it('resolves a 100,000-level condition to an outcome for write and transact, never a throw', async () => {
    const { store } = storeHarness();
    const deep = putAction('ledger', { pk: PK, sk: 'deep' }, nestedAll(100_000, { kind: 'item_absent' }));
    const written = store.write(deep);
    assert.ok(written instanceof Promise);
    assert.deepEqual(await written, refused);
    assert.deepEqual(await store.transact([deep], TOKEN), refused);
    // 2043 levels fit in 4 KB, so DynamoDB evaluates them; the emulator does too.
    const fits = putAction(
      'ledger',
      { pk: PK, sk: 'fits' },
      nestedAll(2043, { kind: 'attribute_equals', name: 'pk', value: 'x' }),
    );
    assert.deepEqual(await store.write(fits), { kind: 'condition_failed', failed_action_index: 0 });
  });

  it('resolves a 200,000-member condition to ValidationException for write and transact, storing nothing', async () => {
    const { store } = storeHarness();
    const wide = putAction(
      'ledger',
      { pk: PK, sk: 'wide' },
      { kind: 'all', conditions: Array.from({ length: 200_000 }, () => ({ kind: 'item_absent' }) as const) },
    );
    assert.deepEqual(await store.write(wide), refused);
    assert.deepEqual(await store.transact([wide], TOKEN), refused);
    assert.deepEqual(store.itemsIn('ledger'), []);
  });

  it('refuses an ADD past the safe-integer range with a subscribed StreamFeed, changing nothing (documented divergence)', async () => {
    const { store, time } = storeHarness();
    const delivered: DynamoDBRecord[] = [];
    const feed = new StreamFeed({
      source: store,
      table: 'control',
      scheduler: time,
      clock: time,
      consumer: (event): Promise<void> => {
        delivered.push(...event.Records);
        return Promise.resolve();
      },
    });
    feed.enable();
    const counter = { pk: PK, sk: 'counter', n: Number.MAX_SAFE_INTEGER };
    store.seed('control', counter);
    const add: WriteAction = {
      kind: 'update',
      table: 'control',
      key: { pk: PK, sk: 'counter' },
      set: {},
      increment: { n: 1 },
      condition: { kind: 'attribute_equals', name: 'n', value: Number.MAX_SAFE_INTEGER },
    };
    assert.deepEqual(await store.write(add), refused);
    assert.deepEqual(await store.transact([add], TOKEN), { kind: 'definitive_failure', code: 'ValidationError' });
    assert.deepEqual(store.peek('control', { pk: PK, sk: 'counter' }), counter);
    const subtract: WriteAction = { ...add, increment: { n: -1 } };
    assert.deepEqual(await store.write(subtract), { kind: 'applied' });
    await time.advanceUntilIdle();
    assert.equal(delivered.length, 1);
    assert.equal(store.peek('control', { pk: PK, sk: 'counter' })?.['n'], Number.MAX_SAFE_INTEGER - 1);
  });

  it('keeps a fractional counter: an ADD to a fraction is storable', async () => {
    const { store } = storeHarness();
    store.seed('control', { pk: PK, sk: 'f', n: 1.5 });
    const add: WriteAction = {
      kind: 'update',
      table: 'control',
      key: { pk: PK, sk: 'f' },
      set: {},
      increment: { n: 1 },
      condition: { kind: 'attribute_equals', name: 'n', value: 1.5 },
    };
    assert.deepEqual(await store.write(add), { kind: 'applied' });
    assert.equal(store.peek('control', { pk: PK, sk: 'f' })?.['n'], 2.5);
  });

  it('refuses a 1 MB cursor as InvalidCursor', async () => {
    const { store } = storeHarness();
    assert.deepEqual(await store.queryPartitionPage('ledger', PK, `${'A'.repeat(1024 * 1024)}=`), {
      ok: false,
      error: { code: 'InvalidCursor' },
    });
    assert.deepEqual(
      await store.queryPartitionPage('ledger', PK, encodePageCursor({ pk: 'q'.repeat(1024 * 1024), sk: 's' })),
      { ok: false, error: { code: 'InvalidCursor' } },
    );
  });

  it('agrees with the shared validator on every generated action, and always resolves', async () => {
    await fc.assert(
      fc.asyncProperty(hostileWriteAction, async (action) => {
        const { store } = storeHarness();
        const outcome = await store.write(action);
        const invalid = validateWriteAction(action).length > 0;
        assert.equal(outcome.kind === 'definitive_failure' && outcome.code === 'ValidationException', invalid);
      }),
      fuzzParameters(),
    );
  });
});
