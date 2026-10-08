// AC-RUA-023 (BR-RUA-045; design §14 row AC-RUA-023): "Given a heartbeat failure, when
// ownership cannot be confirmed, then no new publication starts while uncertain and, if
// ownership is confirmed before the 300 s stale boundary, scheduling resumes."
//
// The real LeaseSession and LeaseHeartbeatLoop run on virtual time against the coordination-
// store emulation (the production lease store adapter over the in-memory coordination table),
// journaling to a real JSONL coordination journal whose every line must satisfy the catalogue
// schema of `lease_event_recorded`. `publicationAllowed()` is the gate every new publication
// asks before it starts; it is false from the first unconfirmed heartbeat until ownership is
// confirmed again, and true once more after that confirmation.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RUN_OWNER,
  invalidLeaseEvents,
  leaseEventNames,
  leaseEvents,
  leaseHarness,
} from '../../support/coordination-lease/lease-fixtures.ts';
import type { LeaseHarness } from '../../support/coordination-lease/lease-fixtures.ts';

async function runningLease(): Promise<LeaseHarness> {
  const lease = leaseHarness();
  assert.deepEqual(await lease.session.acquire(RUN_OWNER), { acquired: true });
  lease.loop.start();
  return lease;
}

function assertStillHeldWithoutLoss(lease: LeaseHarness): void {
  assert.equal(lease.session.loss(), undefined);
  assert.equal(lease.listener.emergencyCleanupRequested(), false);
  assert.equal(lease.loop.isRunning(), true);
}

describe('AC-RUA-023 lease uncertainty', () => {
  it('recovery-before-stale-boundary-resumes', async () => {
    const lease = await runningLease();
    await lease.time.advanceBy(30_000);
    assert.equal(lease.session.publicationAllowed(), true, 'confirmed ownership allows publication');

    // Three beats in a row cannot confirm ownership: a definitive rejection, an ambiguous write
    // that did not land and whose resolving read fails, and another rejection.
    lease.store.failNextWrites(1, { kind: 'definitive_failure', code: 'ThrottlingException' });
    await lease.time.advanceBy(30_000);
    assert.equal(lease.session.publicationAllowed(), false, 'the first failure blocks new publication at once');
    assertStillHeldWithoutLoss(lease);

    lease.store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: false });
    lease.store.failNextReads(1, 'InternalServerError');
    await lease.time.advanceBy(30_000);
    assert.equal(lease.session.publicationAllowed(), false, 'still uncertain after an unresolved beat');

    lease.store.failNextWrites(1, { kind: 'definitive_failure', code: 'ProvisionedThroughputExceededException' });
    await lease.time.advanceBy(30_000);
    assert.equal(lease.session.publicationAllowed(), false, 'still uncertain 120 s after the last confirmation');
    assertStillHeldWithoutLoss(lease);

    // At 150 s, 120 s after the last confirmation and well before the 300 s boundary, the beat
    // confirms ownership: publication may start again and the loop keeps its 30 s cadence.
    await lease.time.advanceBy(30_000);
    assert.equal(lease.session.publicationAllowed(), true, 'confirmation before the boundary resumes scheduling');
    assertStillHeldWithoutLoss(lease);
    assert.equal(lease.session.nextHeartbeatDelayMs(), 30_000);
    await lease.time.advanceBy(30_000);
    assert.equal(lease.session.publicationAllowed(), true);

    assert.deepEqual(leaseEventNames(lease), [
      'ACQUIRED',
      'HEARTBEAT_CONFIRMED',
      'HEARTBEAT_FAILED',
      'HEARTBEAT_FAILED',
      'HEARTBEAT_FAILED',
      'RECOVERED',
      'HEARTBEAT_CONFIRMED',
    ]);
    const events = leaseEvents(lease);
    assert.deepEqual(
      events.map((event) => event.lease_health),
      ['CONFIRMED', 'CONFIRMED', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'CONFIRMED', 'CONFIRMED'],
    );
    assert.deepEqual(
      events.slice(2, 5).map((event) => event.last_confirmed_at),
      ['2026-10-05T12:00:30.000Z', '2026-10-05T12:00:30.000Z', '2026-10-05T12:00:30.000Z'],
      'uncertainty keeps the last confirmed heartbeat',
    );
    assert.equal(events[5]?.last_confirmed_at, '2026-10-05T12:02:30.000Z');
    assert.equal(lease.store.current()?.['lease_version'], 4);

    lease.loop.stop();
    assert.equal(await lease.session.finalize('clean'), 'released');
    assert.deepEqual(invalidLeaseEvents(lease), []);
  });

  it('recovery-on-the-last-beat-before-the-boundary-resumes', async () => {
    const lease = await runningLease();
    // Every beat from 30 s to 240 s fails; the beat at 270 s is the last one before the boundary.
    lease.store.failNextWrites(8, { kind: 'definitive_failure', code: 'ThrottlingException' });
    await lease.time.advanceBy(240_000);
    assert.equal(lease.session.publicationAllowed(), false);
    assert.equal(lease.session.nextHeartbeatDelayMs(), 30_000);
    await lease.time.advanceBy(29_999);
    assert.equal(lease.session.publicationAllowed(), false);
    await lease.time.advanceBy(1);
    assert.equal(lease.session.publicationAllowed(), true);
    assertStillHeldWithoutLoss(lease);
    // The boundary now counts from 270 s: the beat at 300 s keeps the lease.
    await lease.time.advanceBy(30_000);
    assert.equal(lease.session.publicationAllowed(), true);
    assert.deepEqual(leaseEventNames(lease).slice(-3), ['HEARTBEAT_FAILED', 'RECOVERED', 'HEARTBEAT_CONFIRMED']);
    assert.deepEqual(invalidLeaseEvents(lease), []);
  });

  it('a-landed-but-unseen-beat-recovers-at-the-adopted-version', async () => {
    const lease = await runningLease();
    // The write lands but its answer is lost and the resolving read fails: the version moved
    // under the session. The next beat fails its condition, sees this owner still holding the
    // item, adopts the version and stays uncertain; the beat after that confirms.
    lease.store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: true });
    lease.store.failNextReads(1, 'InternalServerError');
    await lease.time.advanceBy(60_000);
    assert.equal(lease.session.publicationAllowed(), false);
    await lease.time.advanceBy(30_000);
    assert.equal(lease.session.publicationAllowed(), true);
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED', 'HEARTBEAT_FAILED', 'HEARTBEAT_FAILED', 'RECOVERED']);
    assert.equal(lease.store.current()?.['lease_version'], 3);
    assert.deepEqual(invalidLeaseEvents(lease), []);
  });
});
