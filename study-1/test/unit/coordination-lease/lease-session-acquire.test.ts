// LeaseSession acquisition and its misuse guards (BR-RUA-045, BR-RUA-046; design §10.2 P1):
// an acquired lease is confirmed at version 1 and opens publication; a refused one names the
// holder and holds nothing; an unresolved one may still be held, so finalization releases it;
// a second acquire, or a heartbeat or finalization before acquiring, is a programming error.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeHolder } from '../../../src/coordination-lease/lease-item.ts';
import {
  EPOCH_UTC,
  FOREIGN_OWNER,
  RUN_ID,
  RUN_MANIFEST_SHA,
  RUN_OWNER,
  leaseEventNames,
  leaseEvents,
  leaseHarness,
  leaseItem,
  storedLeaseItem,
} from '../../support/coordination-lease/lease-fixtures.ts';

describe('LeaseSession.acquire', () => {
  it('acquires a free lease, confirms version 1 and journals ACQUIRED', async () => {
    const lease = leaseHarness();
    assert.equal(lease.session.publicationAllowed(), false);
    assert.deepEqual(await lease.session.acquire(RUN_OWNER), { acquired: true });
    assert.equal(lease.session.publicationAllowed(), true);
    assert.equal(lease.session.nextHeartbeatDelayMs(), 30_000);
    assert.equal(lease.session.loss(), undefined);
    const [event] = leaseEvents(lease);
    assert.equal(event?.lease_event, 'ACQUIRED');
    assert.equal(event.owner_kind, 'RUN');
    assert.equal(event.owner_id, RUN_ID);
    assert.equal(event.owner_manifest_sha256, RUN_MANIFEST_SHA);
    assert.equal(event.lease_version, 1);
    assert.equal(event.lease_health, 'CONFIRMED');
    assert.equal(event.last_confirmed_at, EPOCH_UTC);
    assert.equal(event.detail, 'conditional acquisition applied');
  });

  it('is refused by another holder, names it and journals ACQUISITION_FAILED with the holder pair', async () => {
    const lease = leaseHarness();
    lease.store.takeOverBy(FOREIGN_OWNER, EPOCH_UTC, 2);
    const holder = leaseItem(FOREIGN_OWNER, EPOCH_UTC, { lease_version: 2 });
    const acquisition = await lease.session.acquire(RUN_OWNER);
    assert.deepEqual(acquisition, {
      acquired: false,
      holder,
      reason: {
        code: 'LEASE_CONFLICT',
        subject: 'BR-RUA-045',
        detail: `acquisition refused: the item shows ${describeHolder(holder)}; expected no item or a RELEASED one (an expiry never releases)`,
      },
    });
    assert.equal(lease.session.publicationAllowed(), false);
    assert.equal(lease.session.nextHeartbeatDelayMs(), 0);
    const [event] = leaseEvents(lease);
    assert.equal(event?.lease_event, 'ACQUISITION_FAILED');
    assert.equal(event.holder_owner_kind, 'TRANSPORT_PROBE');
    assert.equal(event.holder_owner_id, FOREIGN_OWNER.owner_id);
    assert.equal(event.lease_version, undefined);
  });

  it('omits the holder when the refusal names none', async () => {
    const lease = leaseHarness();
    lease.store.failNextWrites(1, { kind: 'definitive_failure', code: 'AccessDeniedException' });
    const acquisition = await lease.session.acquire(RUN_OWNER);
    assert.equal(acquisition.acquired, false);
    assert.equal(Object.hasOwn(acquisition, 'holder'), false);
    assert.equal(leaseEvents(lease)[0]?.holder_owner_id, undefined);
  });

  it('settles a refused session as released without touching the store', async () => {
    const lease = leaseHarness();
    lease.store.takeOverBy(FOREIGN_OWNER, EPOCH_UTC, 2);
    await lease.session.acquire(RUN_OWNER);
    const writesBefore = lease.log.entries().length;
    assert.equal(await lease.session.finalize('unclean'), 'released');
    assert.equal(lease.log.entries().length, writesBefore);
    assert.deepEqual(leaseEventNames(lease), ['ACQUISITION_FAILED', 'RELEASED']);
    assert.equal(leaseEvents(lease)[1]?.detail, 'the acquisition was refused; this owner holds nothing');
    assert.deepEqual(lease.store.current(), storedLeaseItem(FOREIGN_OWNER, EPOCH_UTC, { lease_version: 2 }));
  });

  it('releases an unresolved acquisition that landed unseen at finalization', async () => {
    const lease = leaseHarness();
    lease.store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: true });
    lease.store.failNextReads(1, 'InternalServerError');
    const acquisition = await lease.session.acquire(RUN_OWNER);
    assert.equal(acquisition.acquired, false);
    assert.equal(acquisition.reason.code, 'LEASE_WRITE_AMBIGUOUS');
    assert.equal(lease.session.publicationAllowed(), false);
    await assert.rejects(
      lease.session.heartbeatOnce(),
      /heartbeatOnce\(\) in phase unresolved; expected a session that holds the lease/,
    );
    assert.equal(await lease.session.finalize('clean'), 'released');
    assert.equal(lease.store.current()?.['lease_status'], 'RELEASED');
    const events = leaseEvents(lease);
    assert.deepEqual(
      events.map((event) => event.lease_event),
      ['ACQUISITION_FAILED', 'RELEASED'],
    );
    assert.equal(events[1]?.lease_version, undefined);
  });

  it('refuses a second acquire and keeps serving the session afterwards', async () => {
    const lease = leaseHarness();
    await lease.session.acquire(RUN_OWNER);
    await assert.rejects(lease.session.acquire(RUN_OWNER), {
      message: 'acquire() in phase held; expected a session that has not acquired yet',
    });
    assert.equal(await lease.session.heartbeatOnce(), 'CONFIRMED');
  });
});

describe('LeaseSession misuse before acquire', () => {
  it('refuses a heartbeat and a finalization', async () => {
    const lease = leaseHarness();
    await assert.rejects(lease.session.heartbeatOnce(), {
      message: 'heartbeatOnce() in phase idle; expected a session that holds the lease',
    });
    await assert.rejects(lease.session.finalize('clean'), {
      message: 'finalize(clean) before acquire(); expected a session that tried to acquire',
    });
    assert.equal(lease.session.nextHeartbeatDelayMs(), 0);
    assert.deepEqual(leaseEventNames(lease), []);
    assert.equal(lease.log.isEmpty(), true);
  });
});
