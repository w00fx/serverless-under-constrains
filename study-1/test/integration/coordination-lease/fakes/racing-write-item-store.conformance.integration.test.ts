// Conformance of RacingWriteItemStore (design §12.2): a transparent DurableItemStore decorator
// that records single-item writes in order and runs a scripted competing write on the wrapped
// store right after the chosen one, before its outcome returns; reads, queries and
// transactions pass through unchanged.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { RacingWriteItemStore } from '../../../support/coordination-lease/racing-write-item-store.ts';
import { InMemoryItemStore } from '../../../support/durable-store/in-memory-item-store.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';

function wrapped(): { readonly inner: InMemoryItemStore; readonly racing: RacingWriteItemStore } {
  const inner = new InMemoryItemStore({ clock: new VirtualTimeScheduler({ wallEpochMs: 0 }) });
  return { inner, racing: new RacingWriteItemStore(inner) };
}

describe('RacingWriteItemStore conformance', () => {
  it('records writes in order and returns the outcome the wrapped store gave', async () => {
    const { inner, racing } = wrapped();
    const put = {
      kind: 'put',
      table: 'coordination',
      item: { pk: 'a', sk: 'b' },
      condition: { kind: 'item_absent' },
    } as const;
    assert.deepEqual(await racing.write(put), { kind: 'applied' });
    assert.equal((await racing.write(put)).kind, 'condition_failed');
    assert.deepEqual(racing.writes(), [put, put]);
    assert.deepEqual(inner.peek('coordination', { pk: 'a', sk: 'b' }), { pk: 'a', sk: 'b' });
  });

  it('runs the competing write after the chosen write and before its outcome returns', async () => {
    const { inner, racing } = wrapped();
    racing.afterWrite(1, async (store) => {
      await store.write({ kind: 'put', table: 'coordination', item: { pk: 'a', sk: 'b', winner: true } });
    });
    const outcome = await racing.write({ kind: 'put', table: 'coordination', item: { pk: 'a', sk: 'b' } });
    assert.deepEqual(outcome, { kind: 'applied' });
    assert.deepEqual(inner.peek('coordination', { pk: 'a', sk: 'b' }), { pk: 'a', sk: 'b', winner: true });
    assert.equal(racing.writes().length, 1, 'the competing write is not recorded as this writer');
  });

  it('passes reads, queries and transactions through', async () => {
    const { inner, racing } = wrapped();
    inner.seed('coordination', { pk: 'a', sk: 'b' });
    assert.deepEqual(await racing.getConsistent('coordination', { pk: 'a', sk: 'b' }), {
      ok: true,
      value: { pk: 'a', sk: 'b' },
    });
    const page = await racing.queryPartitionPage('coordination', 'a');
    assert.equal(page.ok && page.value.items.length, 1);
    const token = '0d6c9f2e-1b3a-4c5d-8e7f-9a0b1c2d3e4f' as Uuid4;
    const outcome = await racing.transact([{ kind: 'put', table: 'coordination', item: { pk: 'c', sk: 'd' } }], token);
    assert.deepEqual(outcome, { kind: 'applied' });
    assert.deepEqual(racing.writes(), []);
  });
});
