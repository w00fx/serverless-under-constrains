// Conformance of InterleavingItemStore: as a decorator it is transparent (writes, transactions,
// reads and queries reach the wrapped store unchanged), and a scripted interleaving runs on the
// wrapped store right after its read, which still returns the item as it was before.
//
// Sources (RK-17): [R-aws] §1.2, a conditional write fails with ConditionalCheckFailedException
// when the item changed since it was read, so another writer may act between the two.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { InterleavingItemStore } from '../../../support/cleanup/interleaving-item-store.ts';
import { storeHarness } from '../../../support/durable-store/item-store-fixtures.ts';

const KEY = { pk: 'p', sk: 'treatment' };

describe('InterleavingItemStore conformance', () => {
  it('forwards every operation to the wrapped store', async () => {
    const { store } = storeHarness();
    const wrapped = new InterleavingItemStore(store);
    assert.deepEqual(await wrapped.write({ kind: 'put', table: 'control', item: { ...KEY, state: 'ARMED' } }), {
      kind: 'applied',
    });
    assert.deepEqual(
      await wrapped.transact(
        [{ kind: 'put', table: 'control', item: { pk: 'p', sk: 'config' } }],
        '11111111-2222-4333-8444-555555555555' as Uuid4,
      ),
      { kind: 'applied' },
    );
    assert.deepEqual(await wrapped.getConsistent('control', KEY), { ok: true, value: { ...KEY, state: 'ARMED' } });
    const page = await wrapped.queryPartitionPage('control', 'p');
    assert.deepEqual(page.ok ? page.value.items.map((item) => item.sk) : [], ['config', 'treatment']);
    assert.equal(wrapped.readCount(), 1);
  });

  it('runs the interleaving after the chosen read and returns the earlier item', async () => {
    const { store } = storeHarness();
    store.seed('control', { ...KEY, state: 'ARMED', version: 1 });
    const wrapped = new InterleavingItemStore(store);
    wrapped.afterRead(2, async (inner) => {
      await inner.write({
        kind: 'update',
        table: 'control',
        key: KEY,
        set: { state: 'COMMITTED_WAITING' },
        condition: { kind: 'attribute_equals', name: 'state', value: 'ARMED' },
      });
    });
    assert.deepEqual(await wrapped.getConsistent('control', KEY), {
      ok: true,
      value: { ...KEY, state: 'ARMED', version: 1 },
    });
    assert.deepEqual(await wrapped.getConsistent('control', KEY), {
      ok: true,
      value: { ...KEY, state: 'ARMED', version: 1 },
    });
    assert.deepEqual(await wrapped.getConsistent('control', KEY), {
      ok: true,
      value: { ...KEY, state: 'COMMITTED_WAITING', version: 1 },
    });
  });
});
