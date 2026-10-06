// LeaseSession finalization (BR-RUA-045; design §10.2 P8): a clean closure releases and an
// unclean one marks recovery, journaled with the version after the write; a lost lease whose
// item is gone settles as unverified; a finalized session answers again without writing; and
// operations are serialized, so a heartbeat in flight finishes before finalization starts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RUN_OWNER,
  leaseEventNames,
  leaseEvents,
  leaseHarness,
} from '../../support/coordination-lease/lease-fixtures.ts';
import type { LeaseHarness } from '../../support/coordination-lease/lease-fixtures.ts';

async function acquired(): Promise<LeaseHarness> {
  const lease = leaseHarness();
  await lease.session.acquire(RUN_OWNER);
  return lease;
}

describe('LeaseSession.finalize', () => {
  it('releases on a clean closure and journals the version after the write', async () => {
    const lease = await acquired();
    await lease.session.heartbeatOnce();
    assert.equal(await lease.session.finalize('clean'), 'released');
    assert.equal(lease.store.current()?.['lease_status'], 'RELEASED');
    const released = leaseEvents(lease)[2];
    assert.equal(released?.lease_event, 'RELEASED');
    assert.equal(released.lease_version, 3);
    assert.equal(released.lease_health, 'CONFIRMED');
    assert.equal(lease.session.publicationAllowed(), false);
    assert.equal(lease.session.nextHeartbeatDelayMs(), 0);
  });

  it('marks recovery on an unclean closure', async () => {
    const lease = await acquired();
    assert.equal(await lease.session.finalize('unclean'), 'recovery_required');
    assert.equal(lease.store.current()?.['lease_status'], 'RECOVERY_REQUIRED');
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED', 'RECOVERY_REQUIRED']);
  });

  it('keeps the known version in the event when the write did not report one', async () => {
    const lease = await acquired();
    lease.store.failNextWrites(1, { kind: 'definitive_failure', code: 'AccessDeniedException' });
    assert.equal(await lease.session.finalize('clean'), 'unverified');
    const failed = leaseEvents(lease)[1];
    assert.equal(failed?.lease_event, 'RELEASE_FAILED');
    assert.equal(failed.lease_version, 1);
  });

  it('settles a lost lease whose item disappeared as unverified', async () => {
    const lease = await acquired();
    lease.store.deleteLeaseItemAsTtl();
    await lease.session.heartbeatOnce();
    assert.equal(await lease.session.finalize('clean'), 'unverified');
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED', 'LOST_OWNERSHIP_MISMATCH', 'STATE_UNVERIFIED']);
  });

  it('answers a second finalization with the same status, without writing or journaling', async () => {
    const lease = await acquired();
    assert.equal(await lease.session.finalize('clean'), 'released');
    const writes = lease.log.entries().length;
    assert.equal(await lease.session.finalize('unclean'), 'released');
    assert.equal(lease.log.entries().length, writes);
    assert.equal(leaseEvents(lease).length, 2);
    await assert.rejects(lease.session.heartbeatOnce(), /heartbeatOnce\(\) in phase finalized/);
  });

  it('waits for a heartbeat in flight before finalizing', async () => {
    const lease = await acquired();
    lease.store.holdNextWrite();
    const beat = lease.session.heartbeatOnce();
    const finalization = lease.session.finalize('clean');
    await lease.time.advanceBy(0);
    assert.equal(lease.store.isWriteHeld(), true);
    lease.store.releaseHeldWrite();
    assert.equal(await beat, 'CONFIRMED');
    assert.equal(await finalization, 'released');
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED', 'HEARTBEAT_CONFIRMED', 'RELEASED']);
    assert.equal(leaseEvents(lease)[2]?.lease_version, 3);
  });
});
