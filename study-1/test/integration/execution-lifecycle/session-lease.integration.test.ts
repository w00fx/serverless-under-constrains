// The runner's coordination lease over the emulated coordination table (design §10.2 P1, P8,
// §10.3; BR-RUA-045): the owner is the execution bound to its frozen manifest digest, a foreign
// holder refuses acquisition, a foreign takeover is handed to the runner once as a loss, and every
// transition lands in the package's coordination journal.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LeaseLoss } from '../../../src/coordination-lease/lease-session.ts';
import { SessionExecutionLease } from '../../../src/execution-lifecycle/session-lease.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { FakeLeaseStore } from '../../support/coordination-lease/fake-lease-store.ts';
import { FOREIGN_OWNER } from '../../support/coordination-lease/lease-fixtures.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { offlineExecution } from '../../support/offline-cloud/offline-execution.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { admittedOf, lifecycleServices } from './support/execution-fixtures.ts';

const admitted = admittedOf(offlineExecution('run'));
const EPOCH_MS = Date.UTC(2026, 9, 5, 12, 5, 0, 0);

interface LeaseWorld {
  readonly time: VirtualTimeScheduler;
  readonly store: FakeLeaseStore;
  readonly journals: OfflinePackageStorage;
  readonly lease: SessionExecutionLease;
}

function leaseWorld(): LeaseWorld {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
  const store = new FakeLeaseStore({ clock: time });
  const journals = new OfflinePackageStorage();
  const lease = new SessionExecutionLease(admitted, {
    store,
    journals,
    scheduler: time,
    services: lifecycleServices(time).services,
  });
  return { time, store, journals, lease };
}

function coordinationEvents(world: LeaseWorld): readonly string[] {
  const text = new TextDecoder().decode(
    world.journals.filesUnder(admitted.package_directory).get(EXECUTION_PATHS.coordinationJournal) ?? new Uint8Array(),
  );
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => String((JSON.parse(line) as Record<string, unknown>)['lease_event']));
}

describe('SessionExecutionLease', () => {
  it('acquires as the execution bound to its manifest, allows publication and releases a clean closure', async () => {
    const world = leaseWorld();
    world.lease.stopHeartbeats();
    assert.deepEqual(await world.lease.acquire(), { acquired: true });
    assert.equal(world.lease.publicationAllowed(), true);
    const item = await world.store.read();
    assert.ok(item.ok && item.value !== undefined);
    assert.equal(item.value.owner_id, admitted.identity.execution_kind === 'RUN' ? admitted.identity.run_id : '');
    assert.equal(item.value.owner_manifest_sha256, admitted.manifest_sha256);
    assert.equal(await world.lease.finalize('clean'), 'released');
    assert.deepEqual(coordinationEvents(world).slice(-1), ['RELEASED']);
    assert.ok(coordinationEvents(world).length >= 2);
  });

  it('is refused while another owner holds the lease', async () => {
    const world = leaseWorld();
    world.store.takeOverBy(FOREIGN_OWNER, '2026-10-05T12:04:00.000Z' as UtcMillis, 3);
    const acquisition = await world.lease.acquire();
    assert.equal(acquisition.acquired, false);
    assert.ok(acquisition.reason.detail.length > 0);
    assert.equal(world.lease.publicationAllowed(), false);
  });

  it('hands a foreign takeover to the runner once, through the heartbeat', async () => {
    const world = leaseWorld();
    await world.lease.acquire();
    const losses: LeaseLoss[] = [];
    world.lease.startHeartbeats((loss) => losses.push(loss));
    await world.time.advanceBy(30_000);
    assert.equal(losses.length, 0);
    world.store.takeOverBy(FOREIGN_OWNER, '2026-10-05T12:05:31.000Z' as UtcMillis, 9);
    await world.time.advanceBy(90_000);
    world.lease.stopHeartbeats();
    assert.equal(losses.length, 1);
    assert.equal(losses[0]?.cause, 'LEASE_LOST');
    assert.equal(world.lease.publicationAllowed(), false);
    assert.equal(await world.lease.finalize('unclean'), 'unverified');
  });

  it('marks an unclean closure for recovery', async () => {
    const world = leaseWorld();
    await world.lease.acquire();
    world.lease.startHeartbeats(() => undefined);
    await world.time.advanceBy(60_000);
    world.lease.stopHeartbeats();
    assert.equal(await world.lease.finalize('unclean'), 'recovery_required');
    const item = await world.store.read();
    assert.equal(item.ok && item.value?.lease_status, 'RECOVERY_REQUIRED');
  });
});
