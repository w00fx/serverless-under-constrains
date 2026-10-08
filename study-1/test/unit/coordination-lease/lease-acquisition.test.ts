// Resolution of one acquisition write (BR-RUA-045, BR-RUA-046 "an active conflicting lease";
// design §10.2 P1): applied acquires; a failed condition refuses and names the holder from the
// item as it was; a definitive failure refuses; an ambiguous write is settled by a consistent
// read, and stays unresolved when that read fails too.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveAcquisition } from '../../../src/coordination-lease/lease-acquisition.ts';
import type { LeaseItem } from '../../../src/coordination-lease/lease-item.ts';
import { LEASE_ITEM_KEY, describeHolder } from '../../../src/coordination-lease/lease-item.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { FakeLeaseStore } from '../../support/coordination-lease/fake-lease-store.ts';
import {
  EPOCH_MS,
  EPOCH_UTC,
  FOREIGN_OWNER,
  RUN_OWNER,
  leaseItem,
} from '../../support/coordination-lease/lease-fixtures.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

const EARLIER = '2026-10-05T11:00:00.000Z' as UtcMillis;

function storeWith(item?: LeaseItem): FakeLeaseStore {
  const store = new FakeLeaseStore({ clock: new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS }) });
  if (item !== undefined) {
    store.seed({ ...item });
  }
  return store;
}

const conflictDetail = (context: string, holder: LeaseItem): string =>
  `${context}: the item shows ${describeHolder(holder)}; expected no item or a RELEASED one (an expiry never releases)`;

describe('resolveAcquisition', () => {
  it('acquires on an applied write', async () => {
    assert.deepEqual(await resolveAcquisition(storeWith(), RUN_OWNER, EPOCH_UTC, { kind: 'applied' }), {
      kind: 'acquired',
      detail: 'conditional acquisition applied',
    });
  });

  it('refuses on a definitive failure: nothing written', async () => {
    const resolution = await resolveAcquisition(storeWith(), RUN_OWNER, EPOCH_UTC, {
      kind: 'definitive_failure',
      code: 'AccessDeniedException',
    });
    assert.deepEqual(resolution, {
      kind: 'refused',
      reason: {
        code: 'LEASE_WRITE_REJECTED',
        subject: 'BR-RUA-045',
        detail: 'acquisition rejected with AccessDeniedException; nothing written',
      },
    });
  });

  it('refuses a conflicting holder and names it', async () => {
    const holder = leaseItem(FOREIGN_OWNER, EARLIER, { expires_at: EARLIER });
    const resolution = await resolveAcquisition(storeWith(), RUN_OWNER, EPOCH_UTC, {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: { ...holder },
    });
    assert.deepEqual(resolution, {
      kind: 'refused',
      holder,
      reason: { code: 'LEASE_CONFLICT', subject: 'BR-RUA-045', detail: conflictDetail('acquisition refused', holder) },
    });
  });

  it('refuses when the store could not return the existing item', async () => {
    const resolution = await resolveAcquisition(storeWith(), RUN_OWNER, EPOCH_UTC, {
      kind: 'condition_failed',
      failed_action_index: 0,
    });
    assert.deepEqual(resolution, {
      kind: 'refused',
      reason: {
        code: 'LEASE_CONFLICT',
        subject: 'BR-RUA-045',
        detail: 'a lease item exists but the store could not return it',
      },
    });
  });

  it('refuses when the existing item does not decode', async () => {
    const resolution = await resolveAcquisition(storeWith(), RUN_OWNER, EPOCH_UTC, {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: { ...LEASE_ITEM_KEY, extra: true },
    });
    assert.equal(resolution.kind, 'refused');
    assert.equal(resolution.reason.code, 'LEASE_ITEM_UNDECODABLE');
    assert.match(resolution.reason.detail, /^acquisition refused: lease item unknown member string "extra"/);
  });
});

describe('resolveAcquisition on an ambiguous write', () => {
  const ambiguous = { kind: 'ambiguous', code: 'TimeoutError' } as const;

  it('acquires when the read shows this put landed', async () => {
    const store = storeWith(leaseItem(RUN_OWNER, EPOCH_UTC));
    assert.deepEqual(await resolveAcquisition(store, RUN_OWNER, EPOCH_UTC, ambiguous), {
      kind: 'acquired',
      detail: 'ambiguous acquisition (TimeoutError) confirmed by a consistent read',
    });
  });

  it('refuses when the read shows another holder, status, version or acquisition instant', async () => {
    const others: readonly LeaseItem[] = [
      leaseItem(FOREIGN_OWNER, EPOCH_UTC),
      leaseItem(RUN_OWNER, EPOCH_UTC, { lease_status: 'RELEASED' }),
      leaseItem(RUN_OWNER, EPOCH_UTC, { lease_version: 2 }),
      leaseItem(RUN_OWNER, EARLIER),
    ];
    for (const holder of others) {
      const resolution = await resolveAcquisition(storeWith(holder), RUN_OWNER, EPOCH_UTC, ambiguous);
      assert.deepEqual(resolution, {
        kind: 'refused',
        holder,
        reason: {
          code: 'LEASE_CONFLICT',
          subject: 'BR-RUA-045',
          detail: conflictDetail('ambiguous acquisition (TimeoutError) did not land', holder),
        },
      });
    }
  });

  it('refuses when the read shows no item: the put did not land', async () => {
    assert.deepEqual(await resolveAcquisition(storeWith(), RUN_OWNER, EPOCH_UTC, ambiguous), {
      kind: 'refused',
      reason: {
        code: 'LEASE_WRITE_AMBIGUOUS',
        subject: 'BR-RUA-045',
        detail: 'ambiguous acquisition (TimeoutError); the lease item is absent, so the put did not land',
      },
    });
  });

  it('stays unresolved when the read fails', async () => {
    const store = storeWith(leaseItem(RUN_OWNER, EPOCH_UTC));
    store.failNextReads(1, 'RequestLimitExceeded');
    assert.deepEqual(await resolveAcquisition(store, RUN_OWNER, EPOCH_UTC, ambiguous), {
      kind: 'unresolved',
      reason: {
        code: 'LEASE_WRITE_AMBIGUOUS',
        subject: 'BR-RUA-045',
        detail:
          'ambiguous acquisition (TimeoutError); the resolving read failed: consistent read failed with RequestLimitExceeded',
      },
    });
  });
});
