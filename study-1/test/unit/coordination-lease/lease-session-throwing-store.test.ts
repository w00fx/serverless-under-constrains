// LeaseSession over a store that breaks its contract by throwing (BR-RUA-045; WP-22 review).
// A throwing call proves nothing either way, so the session follows its ambiguous paths: a
// heartbeat that throws is an unconfirmed beat (uncertainty blocks new publication at once and
// is journaled); a store that keeps throwing ends in staleness at the 300 s boundary, which the
// heartbeat loop hands to the runner once; an acquisition or a finalization that throws is
// resolved by a consistent read. Regression: before the guard, the first throwing heartbeat
// rejected, the loop ended quietly with ownership still shown as confirmed, and no loss was
// ever reported.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LeaseHeartbeatLoop } from '../../../src/coordination-lease/lease-heartbeat-loop.ts';
import { LeaseSession } from '../../../src/coordination-lease/lease-session.ts';
import {
  RUN_OWNER,
  leaseEventNames,
  leaseEvents,
  leaseHarness,
} from '../../support/coordination-lease/lease-fixtures.ts';
import type { LeaseHarness } from '../../support/coordination-lease/lease-fixtures.ts';
import type { ThrownFault } from '../../support/coordination-lease/throwing-lease-store.ts';
import { ThrowingLeaseStore } from '../../support/coordination-lease/throwing-lease-store.ts';

interface ThrowingLease {
  readonly lease: LeaseHarness;
  readonly throwing: ThrowingLeaseStore;
  readonly session: LeaseSession;
  readonly loop: LeaseHeartbeatLoop;
}

// The harness's time, journal, emulated store and listener, with the session and its loop
// built over the throwing decorator of that store.
function throwingLease(): ThrowingLease {
  const lease = leaseHarness();
  const throwing = new ThrowingLeaseStore(lease.store);
  const session = new LeaseSession({
    store: throwing,
    monotonic: lease.time,
    wall: lease.time,
    journal: lease.journal,
    heartbeatIntervalMs: 30_000,
    staleBoundaryMs: 300_000,
  });
  const loop = new LeaseHeartbeatLoop({ session, scheduler: lease.time, listener: lease.listener });
  return { lease, throwing, session, loop };
}

const SYNC_DEFECT: ThrownFault = { mode: 'throw', error: new TypeError('cannot read properties of undefined') };
const ASYNC_DEFECT: ThrownFault = { mode: 'reject', error: new RangeError('invalid time value') };

describe('LeaseSession over a throwing store: heartbeats', () => {
  it('counts a heartbeat that throws as unconfirmed: uncertainty, publication blocked, journaled', async () => {
    const { lease, throwing, session } = throwingLease();
    await session.acquire(RUN_OWNER);
    await lease.time.advanceBy(30_000);
    throwing.throwOnNextWrites(1, ASYNC_DEFECT);
    assert.equal(await session.heartbeatOnce(), 'UNCERTAIN');
    assert.equal(session.publicationAllowed(), false);
    assert.equal(session.loss(), undefined);
    const failed = leaseEvents(lease)[1];
    assert.equal(failed?.lease_event, 'HEARTBEAT_FAILED');
    assert.equal(
      failed.detail,
      'ambiguous heartbeat (LeaseStoreThrew:RangeError); the item still names this owner, held at version 1 (expected 1)',
    );
    assert.equal(await session.heartbeatOnce(), 'CONFIRMED');
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED', 'HEARTBEAT_FAILED', 'RECOVERED']);
  });

  it('keeps the loop beating through a throwing store until staleness reaches the runner at 300 s', async () => {
    const { lease, throwing, session, loop } = throwingLease();
    await session.acquire(RUN_OWNER);
    loop.start();
    // Every beat from 30 s to 270 s throws, and so does its resolving read.
    throwing.throwOnNextWrites(9, SYNC_DEFECT);
    throwing.throwOnNextReads(9, ASYNC_DEFECT);
    await lease.time.advanceBy(30_000);
    assert.equal(loop.isRunning(), true, 'a throwing beat does not end the loop');
    assert.equal(session.publicationAllowed(), false, 'the first throwing beat blocks publication at once');
    await lease.time.advanceBy(269_999);
    assert.equal(session.loss(), undefined);
    await lease.time.advanceBy(1);
    const losses = lease.listener.losses();
    assert.equal(losses.length, 1);
    assert.equal(losses[0]?.loss.health, 'LOST_STALE');
    assert.equal(losses[0].loss.reason.code, 'LEASE_STALE');
    assert.equal(losses[0].at_ns, 300_000_000_000n);
    assert.equal(loop.isRunning(), false);
    assert.equal(throwing.pendingFaultCount(), 0);
    assert.deepEqual(leaseEventNames(lease), ['ACQUIRED', ...Array<string>(9).fill('HEARTBEAT_FAILED'), 'LOST_STALE']);
    assert.equal(
      leaseEvents(lease)[1]?.detail,
      'ambiguous heartbeat (LeaseStoreThrew:TypeError); ownership unresolved: the consistent read threw RangeError',
    );
  });
});

describe('LeaseSession over a throwing store: acquisition and finalization', () => {
  it('resolves an acquisition that throws by the consistent read: absent, so not landed', async () => {
    const { lease, throwing, session } = throwingLease();
    throwing.throwOnNextWrites(1, SYNC_DEFECT);
    const acquisition = await session.acquire(RUN_OWNER);
    assert.deepEqual(acquisition, {
      acquired: false,
      reason: {
        code: 'LEASE_WRITE_AMBIGUOUS',
        subject: 'BR-RUA-045',
        detail: 'ambiguous acquisition (LeaseStoreThrew:TypeError); the lease item is absent, so the put did not land',
      },
    });
    assert.deepEqual(leaseEventNames(lease), ['ACQUISITION_FAILED']);
  });

  it('leaves an acquisition unresolved when its write and its read both throw', async () => {
    const { lease, throwing, session } = throwingLease();
    throwing.throwOnNextWrites(1, ASYNC_DEFECT);
    throwing.throwOnNextReads(1, SYNC_DEFECT);
    const acquisition = await session.acquire(RUN_OWNER);
    assert.equal(acquisition.acquired, false);
    assert.equal(
      acquisition.reason.detail,
      'ambiguous acquisition (LeaseStoreThrew:RangeError); the resolving read failed: the consistent read threw TypeError',
    );
    // Unresolved: finalization still looks, finds nothing of this owner and holds nothing.
    assert.equal(await session.finalize('clean'), 'released');
    assert.equal(lease.store.current(), undefined);
  });

  it('settles a release that throws as unverified when the consistent read still shows it held', async () => {
    const { lease, throwing, session } = throwingLease();
    await session.acquire(RUN_OWNER);
    throwing.throwOnNextWrites(1, ASYNC_DEFECT);
    assert.equal(await session.finalize('clean'), 'unverified');
    assert.equal(lease.store.current()?.['lease_status'], 'HELD');
    const unverified = leaseEvents(lease)[1];
    assert.equal(unverified?.lease_event, 'STATE_UNVERIFIED');
    assert.match(unverified.detail ?? '', /was ambiguous \(LeaseStoreThrew:RangeError\)/);
  });
});
