// AC-RUA-033 (BR-RUA-045; design §14 row AC-RUA-033): "Given ownership mismatch or a stale
// lease, when the runner sees it, then experimental work stops, publication is blocked and
// emergency cleanup begins; TTL expiry never establishes release."
//
// The real LeaseSession and LeaseHeartbeatLoop run on virtual time against the coordination-
// store emulation and a real JSONL coordination journal (validated against the catalogue). The
// runner side is RecordingLeaseLossListener: the loop hands it the loss, which is the
// interruption of the active trial with `LEASE_LOST` and the request for emergency cleanup.
// Every case ends with that interruption and that request, publication blocked, the loop
// stopped, and a final lease status that is never `released` unless a release write applied.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LeaseSession } from '../../../src/coordination-lease/lease-session.ts';
import {
  EPOCH_UTC,
  FOREIGN_OWNER,
  RUN_OWNER,
  invalidLeaseEvents,
  leaseEventNames,
  leaseEvents,
  leaseHarness,
  storedLeaseItem,
} from '../../support/coordination-lease/lease-fixtures.ts';
import type { LeaseHarness } from '../../support/coordination-lease/lease-fixtures.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';

async function runningLease(): Promise<LeaseHarness> {
  const lease = leaseHarness();
  assert.deepEqual(await lease.session.acquire(RUN_OWNER), { acquired: true });
  lease.loop.start();
  return lease;
}

// The runner's side of AC-RUA-033: work interrupted with LEASE_LOST, emergency cleanup
// requested once, publication blocked, heartbeats stopped.
function assertInterruptedWithEmergencyCleanup(lease: LeaseHarness, reasonCode: string, atMs: number): void {
  assert.equal(lease.listener.interruptionCause(), 'LEASE_LOST');
  assert.equal(lease.listener.emergencyCleanupRequested(), true);
  const losses = lease.listener.losses();
  assert.equal(losses.length, 1, 'the loss reaches the runner once');
  assert.equal(losses[0]?.loss.reason.code, reasonCode);
  assert.equal(losses[0].at_ns, BigInt(atMs) * 1_000_000n);
  assert.equal(lease.session.publicationAllowed(), false);
  assert.equal(lease.loop.isRunning(), false);
  assert.equal(lease.time.pendingTimerCount(), 0);
}

describe('AC-RUA-033 lease loss', () => {
  it('ownership-mismatch', async () => {
    const lease = await runningLease();
    await lease.time.advanceBy(60_000);
    assert.equal(lease.session.publicationAllowed(), true);

    // Another owner holds the lease now (an operator-forced takeover the run never wrote).
    lease.store.takeOverBy(FOREIGN_OWNER, '2026-10-05T12:01:10.000Z' as UtcMillis, 1);
    const foreignItem = lease.store.current();
    await lease.time.advanceBy(30_000);

    assertInterruptedWithEmergencyCleanup(lease, 'LEASE_OWNERSHIP_MISMATCH', 90_000);
    assert.equal(lease.listener.losses()[0]?.loss.health, 'LOST_OWNERSHIP_MISMATCH');
    const lost = leaseEvents(lease).at(-1);
    assert.equal(lost?.lease_event, 'LOST_OWNERSHIP_MISMATCH');
    assert.equal(lost.lease_health, 'LOST_OWNERSHIP_MISMATCH');
    assert.equal(lost.holder_owner_kind, 'TRANSPORT_PROBE');
    assert.equal(lost.holder_owner_id, FOREIGN_OWNER.owner_id);

    // Emergency cleanup ran but this owner cannot release a lease it no longer holds: the
    // foreign item stays untouched and the final status is unverified.
    await lease.time.advanceBy(300_000);
    assert.equal(lease.listener.losses().length, 1);
    assert.equal(await lease.session.finalize('unclean'), 'unverified');
    assert.deepEqual(lease.store.current(), foreignItem);
    assert.deepEqual(leaseEventNames(lease), [
      'ACQUIRED',
      'HEARTBEAT_CONFIRMED',
      'HEARTBEAT_CONFIRMED',
      'LOST_OWNERSHIP_MISMATCH',
      'STATE_UNVERIFIED',
    ]);
    assert.deepEqual(invalidLeaseEvents(lease), []);
  });

  it('stale-past-300s', async () => {
    const lease = await runningLease();
    // The nine heartbeat writes from 30 s to 270 s fail, so the last confirmation stays at 0 s.
    // The beat due at 300 s lands on the boundary itself and writes nothing.
    lease.store.failNextWrites(9, { kind: 'definitive_failure', code: 'ServiceUnavailable' });
    await lease.time.advanceBy(299_999);
    assert.equal(lease.session.loss(), undefined, 'not stale one millisecond before the boundary');
    assert.equal(lease.listener.emergencyCleanupRequested(), false);
    assert.equal(lease.session.publicationAllowed(), false);
    await lease.time.advanceBy(1);

    assertInterruptedWithEmergencyCleanup(lease, 'LEASE_STALE', 300_000);
    assert.equal(lease.store.pendingScriptCount(), 0);
    assert.equal(lease.listener.losses()[0]?.loss.health, 'LOST_STALE');
    assert.equal(
      lease.listener.losses()[0]?.loss.reason.detail,
      'last confirmed heartbeat at 2026-10-05T12:00:00.000Z, 300000 ms ago; expected less than 300000 ms (stale boundary)',
    );
    const names = leaseEventNames(lease);
    assert.deepEqual(names, ['ACQUIRED', ...Array<string>(9).fill('HEARTBEAT_FAILED'), 'LOST_STALE']);
    assert.equal(leaseEvents(lease).at(-1)?.last_confirmed_at, EPOCH_UTC);

    // No heartbeat is written once stale; emergency cleanup ends unclean, so the lease the
    // owner still holds is marked for recovery.
    await lease.time.advanceBy(120_000);
    assert.deepEqual(leaseEventNames(lease), names);
    assert.equal(await lease.session.finalize('unclean'), 'recovery_required');
    assert.equal(lease.store.current()?.['lease_status'], 'RECOVERY_REQUIRED');
    assert.deepEqual(invalidLeaseEvents(lease), []);
  });

  it('ttl-expiry-is-not-release', async () => {
    const lease = await runningLease();
    await lease.time.advanceBy(30_000);

    // Past `expires_at` the item is still held: another owner is refused, whatever the expiry.
    const expired = storedLeaseItem(RUN_OWNER, EPOCH_UTC, { lease_version: 2, heartbeat_at: EPOCH_UTC });
    lease.store.seed({ ...expired, expires_at: '2026-10-05T11:00:00.000Z' });
    const rivalJournal = leaseHarness();
    const rival = new LeaseSession({
      store: lease.store,
      monotonic: lease.time,
      wall: lease.time,
      journal: rivalJournal.journal,
      heartbeatIntervalMs: 30_000,
      staleBoundaryMs: 300_000,
    });
    const refused = await rival.acquire(FOREIGN_OWNER);
    assert.equal(refused.acquired, false);
    assert.equal(refused.reason.code, 'LEASE_CONFLICT');
    assert.deepEqual(leaseEventNames(rivalJournal), ['ACQUISITION_FAILED']);
    assert.deepEqual(invalidLeaseEvents(rivalJournal), []);

    // A TTL-style deletion removes the item without any release write of the owner. The next
    // beat finds no item: ownership is not confirmed and absence never proves release.
    lease.store.deleteLeaseItemAsTtl();
    await lease.time.advanceBy(30_000);

    assertInterruptedWithEmergencyCleanup(lease, 'LEASE_ITEM_ABSENT', 60_000);
    assert.equal(lease.listener.losses()[0]?.loss.health, 'LOST_OWNERSHIP_MISMATCH');
    assert.match(lease.listener.losses()[0]?.loss.reason.detail ?? '', /an absent item never proves release/);

    // Finalization cannot establish release from an absent item, even on a clean closure.
    assert.equal(await lease.session.finalize('clean'), 'unverified');
    assert.equal(lease.store.current(), undefined, 'finalization never recreates or releases the deleted item');
    const ownEvents = leaseEvents(lease);
    assert.deepEqual(
      ownEvents.map((event) => event.lease_event),
      ['ACQUIRED', 'HEARTBEAT_CONFIRMED', 'LOST_OWNERSHIP_MISMATCH', 'STATE_UNVERIFIED'],
    );
    assert.equal(
      ownEvents.some((event) => event.lease_event === 'RELEASED'),
      false,
      'no RELEASED event without a release write',
    );
    assert.deepEqual(invalidLeaseEvents(lease), []);
  });
});
