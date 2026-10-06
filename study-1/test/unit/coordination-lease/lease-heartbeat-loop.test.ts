// The heartbeat loop (BR-RUA-045; design §10.2): one beat every 30 s, never overlapping; a
// second start is a programming error; stop cancels the pending beat and a beat in flight
// schedules nothing after it; the first loss stops the loop and reaches the listener once.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EPOCH_UTC,
  FOREIGN_OWNER,
  RUN_OWNER,
  leaseEventNames,
  leaseHarness,
} from '../../support/coordination-lease/lease-fixtures.ts';
import type { LeaseHarness } from '../../support/coordination-lease/lease-fixtures.ts';

async function running(): Promise<LeaseHarness> {
  const lease = leaseHarness();
  await lease.session.acquire(RUN_OWNER);
  lease.loop.start();
  return lease;
}

describe('LeaseHeartbeatLoop', () => {
  it('beats every 30 s while running', async () => {
    const lease = leaseHarness();
    assert.equal(lease.loop.isRunning(), false);
    await lease.session.acquire(RUN_OWNER);
    lease.loop.start();
    assert.equal(lease.loop.isRunning(), true);
    await lease.time.advanceBy(29_999);
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED']);
    await lease.time.advanceBy(1);
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED', 'HEARTBEAT_CONFIRMED']);
    await lease.time.advanceBy(60_000);
    assert.deepEqual(leaseEventNames(lease), [
      'ACQUIRED',
      'HEARTBEAT_CONFIRMED',
      'HEARTBEAT_CONFIRMED',
      'HEARTBEAT_CONFIRMED',
    ]);
    assert.equal(lease.time.pendingTimerCount(), 1);
  });

  it('refuses a second start', async () => {
    const lease = await running();
    assert.throws(() => {
      lease.loop.start();
    }, /^Error: LeaseHeartbeatLoop.start\(\) called twice; expected one start per loop$/);
    assert.equal(lease.time.pendingTimerCount(), 1);
  });

  it('cancels the pending beat on stop', async () => {
    const lease = await running();
    lease.loop.stop();
    assert.equal(lease.loop.isRunning(), false);
    assert.equal(lease.time.pendingTimerCount(), 0);
    await lease.time.advanceBy(120_000);
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED']);
    lease.loop.stop();
    assert.equal(lease.loop.isRunning(), false);
  });

  it('lets a beat in flight finish after stop and schedules nothing more', async () => {
    const lease = await running();
    lease.store.holdNextWrite();
    await lease.time.advanceBy(30_000);
    assert.equal(lease.store.isWriteHeld(), true);
    lease.loop.stop();
    lease.store.releaseHeldWrite();
    await lease.time.advanceBy(0);
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED', 'HEARTBEAT_CONFIRMED']);
    assert.equal(lease.time.pendingTimerCount(), 0);
  });

  it('never overlaps beats: the next one is scheduled after the previous settled', async () => {
    const lease = await running();
    lease.store.holdNextWrite();
    await lease.time.advanceBy(30_000);
    assert.equal(lease.time.pendingTimerCount(), 0);
    lease.store.releaseHeldWrite();
    await lease.time.advanceBy(0);
    assert.equal(lease.time.pendingTimerCount(), 1);
  });

  it('stops at the first loss and tells the listener once', async () => {
    const lease = await running();
    lease.store.takeOverBy(FOREIGN_OWNER, EPOCH_UTC, 9);
    await lease.time.advanceBy(30_000);
    assert.equal(lease.loop.isRunning(), false);
    assert.equal(lease.time.pendingTimerCount(), 0);
    const losses = lease.listener.losses();
    assert.equal(losses.length, 1);
    assert.equal(losses[0]?.loss.health, 'LOST_OWNERSHIP_MISMATCH');
    assert.equal(losses[0].at_ns, 30_000_000_000n);
    await lease.time.advanceBy(300_000);
    assert.equal(lease.listener.losses().length, 1);
  });

  it('ends quietly when the lease was finalized before the beat fell due', async () => {
    const lease = await running();
    assert.equal(await lease.session.finalize('clean'), 'released');
    await lease.time.advanceBy(30_000);
    assert.equal(lease.loop.isRunning(), false);
    assert.equal(lease.time.pendingTimerCount(), 0);
    assert.deepEqual(lease.listener.losses(), []);
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED', 'RELEASED']);
  });

  it('ends quietly when finalization was in flight as the beat fell due', async () => {
    const lease = await running();
    await lease.time.advanceBy(29_000);
    lease.store.holdNextWrite();
    const finalization = lease.session.finalize('clean');
    await lease.time.advanceBy(1_000);
    lease.store.releaseHeldWrite();
    assert.equal(await finalization, 'released');
    await lease.time.advanceBy(0);
    assert.equal(lease.loop.isRunning(), false);
    assert.equal(lease.time.pendingTimerCount(), 0);
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED', 'RELEASED']);
  });

  it('keeps beating through uncertainty', async () => {
    const lease = await running();
    lease.store.failNextWrites(1, { kind: 'definitive_failure', code: 'ThrottlingException' });
    await lease.time.advanceBy(60_000);
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED', 'HEARTBEAT_FAILED', 'RECOVERED']);
    assert.equal(lease.loop.isRunning(), true);
  });
});
