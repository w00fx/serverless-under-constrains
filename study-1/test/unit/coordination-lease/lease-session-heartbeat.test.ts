// LeaseSession heartbeats (BR-RUA-045; design §10.3): a confirmed beat keeps publication open;
// a first failure enters uncertainty, blocks publication at once and journals HEARTBEAT_FAILED;
// a confirmation before the boundary journals RECOVERED; a mismatch or staleness is a loss with
// its reason, journaled once, after which no heartbeat is written; a beat whose write completes
// at or past the boundary is stale, not confirmed.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeHolder } from '../../../src/coordination-lease/lease-item.ts';
import {
  EPOCH_UTC,
  FOREIGN_OWNER,
  RUN_OWNER,
  leaseEventNames,
  leaseEvents,
  leaseHarness,
  leaseItem,
} from '../../support/coordination-lease/lease-fixtures.ts';
import type { LeaseHarness } from '../../support/coordination-lease/lease-fixtures.ts';

async function acquired(): Promise<LeaseHarness> {
  const lease = leaseHarness();
  await lease.session.acquire(RUN_OWNER);
  return lease;
}

function heartbeatWrites(lease: LeaseHarness): number {
  return lease.log.entries().filter((entry) => entry.operation === 'UpdateItem').length;
}

describe('LeaseSession.heartbeatOnce while held', () => {
  it('confirms, raises the version and journals HEARTBEAT_CONFIRMED', async () => {
    const lease = await acquired();
    await lease.time.advanceBy(30_000);
    assert.equal(await lease.session.heartbeatOnce(), 'CONFIRMED');
    assert.equal(lease.store.current()?.['lease_version'], 2);
    assert.equal(lease.store.current()?.['heartbeat_at'], '2026-10-05T12:00:30.000Z');
    const beat = leaseEvents(lease)[1];
    assert.equal(beat?.lease_event, 'HEARTBEAT_CONFIRMED');
    assert.equal(beat.lease_version, 2);
    assert.equal(beat.last_confirmed_at, '2026-10-05T12:00:30.000Z');
    assert.equal(lease.session.publicationAllowed(), true);
  });

  it('enters uncertainty on a failed beat, blocks publication, and recovers on the next', async () => {
    const lease = await acquired();
    lease.store.failNextWrites(1, { kind: 'definitive_failure', code: 'ThrottlingException' });
    await lease.time.advanceBy(30_000);
    assert.equal(await lease.session.heartbeatOnce(), 'UNCERTAIN');
    assert.equal(lease.session.publicationAllowed(), false);
    assert.equal(lease.session.loss(), undefined);
    const failed = leaseEvents(lease)[1];
    assert.equal(failed?.lease_health, 'UNCERTAIN');
    assert.equal(failed.last_confirmed_at, EPOCH_UTC);
    assert.equal(failed.detail, 'heartbeat rejected with ThrottlingException');
    await lease.time.advanceBy(30_000);
    assert.equal(await lease.session.heartbeatOnce(), 'CONFIRMED');
    assert.equal(lease.session.publicationAllowed(), true);
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED', 'HEARTBEAT_FAILED', 'RECOVERED']);
  });

  it('adopts the version of an unseen landed beat and confirms at the next one', async () => {
    const lease = await acquired();
    lease.store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: true });
    lease.store.failNextReads(1, 'InternalServerError');
    assert.equal(await lease.session.heartbeatOnce(), 'UNCERTAIN');
    assert.equal(await lease.session.heartbeatOnce(), 'UNCERTAIN');
    assert.equal(leaseEvents(lease)[2]?.lease_version, 2);
    assert.equal(await lease.session.heartbeatOnce(), 'CONFIRMED');
    assert.equal(lease.store.current()?.['lease_version'], 3);
  });

  it('loses on an ownership mismatch, names the holder and stops writing', async () => {
    const lease = await acquired();
    lease.store.takeOverBy(FOREIGN_OWNER, EPOCH_UTC, 7);
    const foreign = leaseItem(FOREIGN_OWNER, EPOCH_UTC, { lease_version: 7 });
    assert.equal(await lease.session.heartbeatOnce(), 'LOST_OWNERSHIP_MISMATCH');
    assert.deepEqual(lease.session.loss(), {
      cause: 'LEASE_LOST',
      health: 'LOST_OWNERSHIP_MISMATCH',
      reason: {
        code: 'LEASE_OWNERSHIP_MISMATCH',
        subject: 'BR-RUA-045',
        detail: `heartbeat condition failed; the item shows ${describeHolder(foreign)}`,
      },
    });
    const lost = leaseEvents(lease)[1];
    assert.equal(lost?.lease_event, 'LOST_OWNERSHIP_MISMATCH');
    assert.equal(lost.holder_owner_id, FOREIGN_OWNER.owner_id);
    const writes = heartbeatWrites(lease);
    assert.equal(await lease.session.heartbeatOnce(), 'LOST_OWNERSHIP_MISMATCH');
    assert.equal(heartbeatWrites(lease), writes);
    assert.equal(leaseEvents(lease).length, 2);
    assert.equal(lease.session.publicationAllowed(), false);
  });

  it('loses on an absent item with the absence code', async () => {
    const lease = await acquired();
    lease.store.deleteLeaseItemAsTtl();
    assert.equal(await lease.session.heartbeatOnce(), 'LOST_OWNERSHIP_MISMATCH');
    assert.equal(lease.session.loss()?.reason.code, 'LEASE_ITEM_ABSENT');
  });
});

describe('LeaseSession.heartbeatOnce at the stale boundary', () => {
  it('declares staleness without writing once 300 s passed since the last confirmation', async () => {
    const lease = await acquired();
    await lease.time.advanceBy(300_000);
    const writes = heartbeatWrites(lease);
    assert.equal(await lease.session.heartbeatOnce(), 'LOST_STALE');
    assert.equal(heartbeatWrites(lease), writes);
    assert.deepEqual(lease.session.loss(), {
      cause: 'LEASE_LOST',
      health: 'LOST_STALE',
      reason: {
        code: 'LEASE_STALE',
        subject: 'BR-RUA-045',
        detail:
          'last confirmed heartbeat at 2026-10-05T12:00:00.000Z, 300000 ms ago; expected less than 300000 ms (stale boundary)',
      },
    });
    assert.equal(leaseEvents(lease)[1]?.lease_event, 'LOST_STALE');
    assert.equal(leaseEvents(lease)[1]?.lease_health, 'LOST_STALE');
  });

  it('still writes one millisecond before the boundary', async () => {
    const lease = await acquired();
    await lease.time.advanceBy(299_999);
    assert.equal(await lease.session.heartbeatOnce(), 'CONFIRMED');
  });

  it('treats a beat whose write completes past the boundary as stale', async () => {
    const lease = await acquired();
    await lease.time.advanceBy(290_000);
    lease.store.holdNextWrite();
    const beat = lease.session.heartbeatOnce();
    await lease.time.advanceBy(0);
    assert.equal(lease.store.isWriteHeld(), true);
    await lease.time.advanceBy(15_000);
    lease.store.releaseHeldWrite();
    assert.equal(await beat, 'LOST_STALE');
    assert.equal(
      lease.session.loss()?.reason.detail,
      'last confirmed heartbeat at 2026-10-05T12:00:00.000Z, 305000 ms ago; expected less than 300000 ms (stale boundary)',
    );
    assert.equal(lease.store.current()?.['lease_version'], 2);
  });

  it('measures staleness on the monotonic clock, not the wall clock', async () => {
    const lease = await acquired();
    lease.time.skewWall(3_600_000);
    assert.equal(await lease.session.heartbeatOnce(), 'CONFIRMED');
  });
});
