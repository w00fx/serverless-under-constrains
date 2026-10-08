// The session's store guard (BR-RUA-045; WP-22 review): outcomes the store returns pass
// through unchanged; a write that throws or rejects, on any write method, resolves as an
// ambiguous write named after the error; a read that throws or rejects resolves as a
// LEASE_READ_FAILED failure; a non-Error value and an over-long error name stay bounded.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LEASE_STORE_THREW, guardLeaseStore } from '../../../src/coordination-lease/guarded-lease-store.ts';
import type { LeaseStorePort } from '../../../src/coordination-lease/lease-store-port.ts';
import { FakeLeaseStore } from '../../support/coordination-lease/fake-lease-store.ts';
import {
  EPOCH_MS,
  EPOCH_UTC,
  RUN_OWNER,
  leaseItem,
  storedLeaseItem,
} from '../../support/coordination-lease/lease-fixtures.ts';
import type { ThrownFault } from '../../support/coordination-lease/throwing-lease-store.ts';
import { ThrowingLeaseStore } from '../../support/coordination-lease/throwing-lease-store.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

interface GuardedUnderTest {
  readonly inner: FakeLeaseStore;
  readonly throwing: ThrowingLeaseStore;
  readonly guarded: LeaseStorePort;
}

function guardedUnderTest(): GuardedUnderTest {
  const inner = new FakeLeaseStore({ clock: new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS }) });
  inner.seed(storedLeaseItem(RUN_OWNER, EPOCH_UTC));
  const throwing = new ThrowingLeaseStore(inner);
  return { inner, throwing, guarded: guardLeaseStore(throwing) };
}

const SYNC_DEFECT: ThrownFault = { mode: 'throw', error: new TypeError('cannot read properties of undefined') };
const ASYNC_DEFECT: ThrownFault = { mode: 'reject', error: new RangeError('invalid time value') };

describe('guardLeaseStore', () => {
  it('passes returned outcomes and reads through unchanged', async () => {
    const { inner, guarded } = guardedUnderTest();
    inner.failNextWrites(1, { kind: 'definitive_failure', code: 'ThrottlingException' });
    assert.deepEqual(await guarded.heartbeat(RUN_OWNER, 1, EPOCH_UTC), {
      kind: 'definitive_failure',
      code: 'ThrottlingException',
    });
    assert.deepEqual(await guarded.heartbeat(RUN_OWNER, 1, EPOCH_UTC), { kind: 'applied' });
    assert.deepEqual(await guarded.markRecoveryRequired(RUN_OWNER, 2, EPOCH_UTC), { kind: 'applied' });
    assert.deepEqual(await guarded.release(RUN_OWNER, 3, EPOCH_UTC), { kind: 'applied' });
    const read = await guarded.read();
    assert.equal(read.ok && read.value?.lease_status, 'RELEASED');
    assert.equal((await guarded.acquire(RUN_OWNER, EPOCH_UTC)).kind, 'applied');
    inner.failNextReads(1, 'InternalServerError');
    assert.deepEqual(await guarded.read(), {
      ok: false,
      error: { code: 'LEASE_READ_FAILED', detail: 'consistent read failed with InternalServerError' },
    });
  });

  it('turns a synchronous throw of each write method into an ambiguous write', async () => {
    const { inner, throwing, guarded } = guardedUnderTest();
    throwing.throwOnNextWrites(4, SYNC_DEFECT);
    const ambiguous = { kind: 'ambiguous', code: 'LeaseStoreThrew:TypeError' };
    assert.deepEqual(await guarded.acquire(RUN_OWNER, EPOCH_UTC), ambiguous);
    assert.deepEqual(await guarded.heartbeat(RUN_OWNER, 1, EPOCH_UTC), ambiguous);
    assert.deepEqual(await guarded.release(RUN_OWNER, 1, EPOCH_UTC), ambiguous);
    assert.deepEqual(await guarded.markRecoveryRequired(RUN_OWNER, 1, EPOCH_UTC), ambiguous);
    assert.equal(LEASE_STORE_THREW, 'LeaseStoreThrew');
    assert.deepEqual(inner.current(), storedLeaseItem(RUN_OWNER, EPOCH_UTC), 'nothing was written');
  });

  it('turns a rejection of each write method into an ambiguous write', async () => {
    const { throwing, guarded } = guardedUnderTest();
    throwing.throwOnNextWrites(4, ASYNC_DEFECT);
    const ambiguous = { kind: 'ambiguous', code: 'LeaseStoreThrew:RangeError' };
    assert.deepEqual(await guarded.acquire(RUN_OWNER, EPOCH_UTC), ambiguous);
    assert.deepEqual(await guarded.heartbeat(RUN_OWNER, 1, EPOCH_UTC), ambiguous);
    assert.deepEqual(await guarded.release(RUN_OWNER, 1, EPOCH_UTC), ambiguous);
    assert.deepEqual(await guarded.markRecoveryRequired(RUN_OWNER, 1, EPOCH_UTC), ambiguous);
  });

  it('turns a throwing or rejecting read into a read failure', async () => {
    const { throwing, guarded } = guardedUnderTest();
    throwing.throwOnNextReads(1, SYNC_DEFECT);
    throwing.throwOnNextReads(1, ASYNC_DEFECT);
    assert.deepEqual(await guarded.read(), {
      ok: false,
      error: { code: 'LEASE_READ_FAILED', detail: 'the consistent read threw TypeError' },
    });
    assert.deepEqual(await guarded.read(), {
      ok: false,
      error: { code: 'LEASE_READ_FAILED', detail: 'the consistent read threw RangeError' },
    });
    assert.deepEqual(await guarded.read(), { ok: true, value: leaseItem(RUN_OWNER, EPOCH_UTC) });
  });

  it('names a non-Error value and bounds an over-long error name', async () => {
    const { throwing, guarded } = guardedUnderTest();
    throwing.throwOnNextWrites(1, { mode: 'reject', error: 'boom' });
    assert.deepEqual(await guarded.heartbeat(RUN_OWNER, 1, EPOCH_UTC), {
      kind: 'ambiguous',
      code: 'LeaseStoreThrew:NonErrorThrown',
    });
    const longName = Object.assign(new Error('x'), { name: 'N'.repeat(5_000) });
    throwing.throwOnNextReads(1, { mode: 'throw', error: longName });
    assert.deepEqual(await guarded.read(), {
      ok: false,
      error: { code: 'LEASE_READ_FAILED', detail: `the consistent read threw ${'N'.repeat(200)}…[truncated]` },
    });
  });
});
