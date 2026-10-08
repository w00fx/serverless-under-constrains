// Conformance of ThrowingLeaseStore (design §12.2; WP-22 review): a scripted call breaks the
// lease store port contract the way a defective adapter would, by a synchronous throw or by a
// rejected promise, and leaves the wrapped coordination-store emulation untouched; faults are
// consumed in order, writes and reads separately; unscripted calls pass through unchanged.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeLeaseStore } from '../../../support/coordination-lease/fake-lease-store.ts';
import { EPOCH_MS, EPOCH_UTC, RUN_OWNER, storedLeaseItem } from '../../../support/coordination-lease/lease-fixtures.ts';
import { ThrowingLeaseStore } from '../../../support/coordination-lease/throwing-lease-store.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';

function wrapped(): { readonly inner: FakeLeaseStore; readonly store: ThrowingLeaseStore } {
  const inner = new FakeLeaseStore({ clock: new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS }) });
  return { inner, store: new ThrowingLeaseStore(inner) };
}

const DEFECT = new TypeError('adapter defect');

describe('ThrowingLeaseStore conformance', () => {
  it('throws synchronously on a scripted write and leaves the table untouched', () => {
    const { inner, store } = wrapped();
    store.throwOnNextWrites(1, { mode: 'throw', error: DEFECT });
    assert.throws(() => store.acquire(RUN_OWNER, EPOCH_UTC), DEFECT);
    assert.equal(inner.current(), undefined);
    assert.equal(store.pendingFaultCount(), 0);
  });

  it('rejects on a scripted write, for every write method in turn', async () => {
    const { inner, store } = wrapped();
    inner.seed(storedLeaseItem(RUN_OWNER, EPOCH_UTC));
    store.throwOnNextWrites(3, { mode: 'reject', error: DEFECT });
    await assert.rejects(store.heartbeat(RUN_OWNER, 1, EPOCH_UTC), DEFECT);
    await assert.rejects(store.release(RUN_OWNER, 1, EPOCH_UTC), DEFECT);
    await assert.rejects(store.markRecoveryRequired(RUN_OWNER, 1, EPOCH_UTC), DEFECT);
    assert.deepEqual(inner.current(), storedLeaseItem(RUN_OWNER, EPOCH_UTC));
  });

  it('breaks scripted reads apart from writes, a non-Error value included', async () => {
    const { store } = wrapped();
    store.throwOnNextReads(2, { mode: 'reject', error: 'not an Error' });
    assert.equal(store.pendingFaultCount(), 2);
    await assert.rejects(store.read(), (error: unknown) => error === 'not an Error');
    assert.deepEqual(await store.acquire(RUN_OWNER, EPOCH_UTC), { kind: 'applied' });
    await assert.rejects(store.read(), (error: unknown) => error === 'not an Error');
    assert.equal(store.pendingFaultCount(), 0);
  });

  it('passes unscripted calls to the wrapped store unchanged', async () => {
    const { inner, store } = wrapped();
    assert.deepEqual(await store.acquire(RUN_OWNER, EPOCH_UTC), { kind: 'applied' });
    assert.deepEqual(await store.heartbeat(RUN_OWNER, 1, EPOCH_UTC), { kind: 'applied' });
    assert.deepEqual(await store.markRecoveryRequired(RUN_OWNER, 2, EPOCH_UTC), { kind: 'applied' });
    assert.deepEqual(await store.release(RUN_OWNER, 3, EPOCH_UTC), { kind: 'applied' });
    const read = await store.read();
    assert.equal(read.ok && read.value?.lease_status, 'RELEASED');
    assert.equal(inner.current()?.['lease_version'], 4);
  });
});
