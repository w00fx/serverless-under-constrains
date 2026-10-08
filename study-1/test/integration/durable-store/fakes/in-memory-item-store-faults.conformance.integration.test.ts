// Conformance of InMemoryItemStore, continued (design §12.2, RK-17): scripted faults, the
// shared mutation log, and the change feed behind StreamFeed. Sources: Programming.Errors.html
// (definitive versus ambiguous outcomes), Streams.html (one record per changed item, none for
// an unchanged write).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ItemChange } from '../../../support/durable-store/in-memory-item-store.ts';
import {
  ARMED,
  COMMIT_TREATMENT,
  PK,
  putAction,
  storeHarness,
  TOKEN,
} from '../../../support/durable-store/item-store-fixtures.ts';

describe('InMemoryItemStore fault injection', () => {
  const ledger = putAction('ledger', { pk: PK, sk: 'tx#1' }, { kind: 'item_absent' });

  it('a scripted definitive failure applies nothing', async () => {
    const { store } = storeHarness();
    store.scriptWriteFault({ kind: 'definitive_failure', code: 'ThrottlingException' });
    assert.deepEqual(await store.write(ledger), { kind: 'definitive_failure', code: 'ThrottlingException' });
    assert.deepEqual(store.itemsIn('ledger'), []);
    assert.deepEqual(await store.write(ledger), { kind: 'applied' });
  });

  it('an ambiguous outcome may have applied (then the response was lost) or not', async () => {
    const { store } = storeHarness();
    store.scriptWriteFault({ kind: 'ambiguous', code: 'TimeoutError', applied: true });
    store.scriptWriteFault({ kind: 'ambiguous', code: 'ECONNRESET', applied: false });
    assert.deepEqual(await store.write(ledger), { kind: 'ambiguous', code: 'TimeoutError' });
    assert.equal(store.itemsIn('ledger').length, 1);
    const second = putAction('ledger', { pk: PK, sk: 'tx#2' });
    assert.deepEqual(await store.write(second), { kind: 'ambiguous', code: 'ECONNRESET' });
    assert.equal(store.itemsIn('ledger').length, 1);
  });

  it('an applied ambiguous transaction registers its token, so the identical retry does not re-apply', async () => {
    const { store } = storeHarness();
    store.seed('control', ARMED);
    store.scriptWriteFault({ kind: 'ambiguous', code: 'TimeoutError', applied: true }, { operation: 'transact' });
    assert.deepEqual(await store.transact([COMMIT_TREATMENT], TOKEN), { kind: 'ambiguous', code: 'TimeoutError' });
    assert.deepEqual(await store.transact([COMMIT_TREATMENT], TOKEN), { kind: 'applied' });
    assert.equal(store.peek('control', { pk: PK, sk: 'treatment' })?.['version'], 2);
  });

  it('faults target an operation and a table, in queue order', async () => {
    const { store } = storeHarness();
    store.scriptWriteFault({ kind: 'definitive_failure', code: 'A' }, { operation: 'transact' });
    store.scriptWriteFault({ kind: 'definitive_failure', code: 'B' }, { table: 'control' });
    store.scriptReadFault('C', { operation: 'queryPartitionPage', table: 'ledger' });
    store.scriptReadFault('D', { table: 'control' });
    assert.equal(store.pendingFaultCount(), 4);
    assert.deepEqual(await store.write(ledger), { kind: 'applied' });
    assert.deepEqual(await store.getConsistent('ledger', { pk: PK, sk: 'tx#1' }), {
      ok: true,
      value: { pk: PK, sk: 'tx#1' },
    });
    assert.deepEqual(await store.write(putAction('control', { pk: PK, sk: 'c' })), {
      kind: 'definitive_failure',
      code: 'B',
    });
    assert.deepEqual(await store.transact([putAction('ledger', { pk: PK, sk: 'tx#2' })], TOKEN), {
      kind: 'definitive_failure',
      code: 'A',
    });
    assert.deepEqual(await store.getConsistent('control', { pk: PK, sk: 'c' }), { ok: false, error: { code: 'D' } });
    assert.deepEqual(await store.queryPartitionPage('control', PK), {
      ok: true,
      value: { items: [], consistent_read: true },
    });
    assert.deepEqual(await store.queryPartitionPage('ledger', PK), { ok: false, error: { code: 'C' } });
    assert.equal(store.pendingFaultCount(), 0);
  });

  it('a transaction fault matches any of its tables; an untargeted read fault matches any read', async () => {
    const { store } = storeHarness();
    store.scriptWriteFault({ kind: 'definitive_failure', code: 'E' }, { table: 'control' });
    store.scriptReadFault('F');
    assert.deepEqual(await store.transact([ledger, putAction('control', { pk: PK, sk: 'c' })], TOKEN), {
      kind: 'definitive_failure',
      code: 'E',
    });
    assert.deepEqual(await store.queryPartitionPage('experiment_journal', PK), { ok: false, error: { code: 'F' } });
  });
});

describe('InMemoryItemStore mutation log and change feed', () => {
  it('logs every write call in order, including refused ones, and no reads', async () => {
    const { store, log } = storeHarness();
    await store.write(putAction('ledger', { pk: PK, sk: 'tx#1' }));
    await store.write(COMMIT_TREATMENT);
    await store.write({
      kind: 'condition_check',
      table: 'control',
      key: { pk: PK, sk: 'c' },
      condition: { kind: 'item_absent' },
    });
    await store.transact(
      [putAction('ledger', { pk: PK, sk: 'tx#2' }), putAction('experiment_journal', { pk: PK, sk: 'e' })],
      TOKEN,
    );
    await store.getConsistent('ledger', { pk: PK, sk: 'tx#1' });
    store.seed('ledger', { pk: PK, sk: 'seeded' });
    assert.deepEqual(log.entries(), [
      { sequence: 1, port: 'dynamodb', operation: 'PutItem', target: 'ledger', detail: { pk: PK, sk: 'tx#1' } },
      {
        sequence: 2,
        port: 'dynamodb',
        operation: 'UpdateItem',
        target: 'control',
        detail: { pk: PK, sk: 'treatment' },
      },
      {
        sequence: 3,
        port: 'dynamodb',
        operation: 'TransactWriteItems',
        target: 'control',
        detail: { pk: PK, sk: 'c' },
      },
      {
        sequence: 4,
        port: 'dynamodb',
        operation: 'TransactWriteItems',
        target: 'ledger,experiment_journal',
        detail: { client_request_token: TOKEN, action_count: 2 },
      },
    ]);
  });

  it('emits INSERT and MODIFY per changed item of the subscribed table, and nothing for unchanged writes', async () => {
    const { store } = storeHarness();
    const changes: ItemChange[] = [];
    const unsubscribe = store.subscribe('caller_journal', (change) => changes.push(change));
    store.subscribe('control', () => {
      throw new Error('a control change must not reach a caller_journal subscriber');
    });
    store.seed('caller_journal', { pk: PK, sk: 'seeded' });
    await store.write(putAction('caller_journal', { pk: PK, sk: 'e#1', v: 1 }));
    await store.write(putAction('caller_journal', { pk: PK, sk: 'e#1', v: 1 }));
    await store.write({
      kind: 'update',
      table: 'caller_journal',
      key: { pk: PK, sk: 'e#1' },
      set: { v: 2 },
      condition: { kind: 'attribute_equals', name: 'v', value: 1 },
    });
    await store.transact(
      [putAction('caller_journal', { pk: PK, sk: 'e#2' }), putAction('caller_journal', { pk: PK, sk: 'e#3' })],
      TOKEN,
    );
    await store.write({
      kind: 'condition_check',
      table: 'caller_journal',
      key: { pk: PK, sk: 'e#1' },
      condition: { kind: 'item_absent' },
    });
    unsubscribe();
    await store.write(putAction('caller_journal', { pk: PK, sk: 'e#4' }));
    assert.deepEqual(changes, [
      {
        table: 'caller_journal',
        event_name: 'INSERT',
        keys: { pk: PK, sk: 'e#1' },
        new_image: { pk: PK, sk: 'e#1', v: 1 },
      },
      {
        table: 'caller_journal',
        event_name: 'MODIFY',
        keys: { pk: PK, sk: 'e#1' },
        new_image: { pk: PK, sk: 'e#1', v: 2 },
        old_image: { pk: PK, sk: 'e#1', v: 1 },
      },
      { table: 'caller_journal', event_name: 'INSERT', keys: { pk: PK, sk: 'e#2' }, new_image: { pk: PK, sk: 'e#2' } },
      { table: 'caller_journal', event_name: 'INSERT', keys: { pk: PK, sk: 'e#3' }, new_image: { pk: PK, sk: 'e#3' } },
    ]);
  });

  it('lists a table ordered by partition then sort key', () => {
    const { store } = storeHarness();
    store.seed('ledger', { pk: 'b', sk: '2' });
    store.seed('ledger', { pk: 'a', sk: '9' });
    store.seed('ledger', { pk: 'b', sk: '1' });
    assert.deepEqual(
      store.itemsIn('ledger').map((item) => `${item.pk}/${item.sk}`),
      ['a/9', 'b/1', 'b/2'],
    );
    assert.deepEqual(store.itemsIn('control'), []);
    assert.equal(store.peek('control', { pk: 'a', sk: '9' }), undefined);
  });
});
