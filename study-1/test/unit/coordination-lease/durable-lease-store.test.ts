// The lease store adapter over the durable item store (BR-RUA-045; design §10.3; [R-aws] §1.2):
// acquisition succeeds only on no item or an explicitly released one, never on an expired held
// item; two owners racing for a released lease cannot both win; heartbeat, release and recovery
// are conditioned on this owner's kind, id and manifest digest, the expected version and the
// permitted statuses, and each raises the version by one; reads are consistent and decoded.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDurableLeaseStore } from '../../../src/coordination-lease/durable-lease-store.ts';
import type { LeaseItem, LeaseItemStatus } from '../../../src/coordination-lease/lease-item.ts';
import { LEASE_ITEM_KEY, acquiredLeaseItem, toStoredItem } from '../../../src/coordination-lease/lease-item.ts';
import type { LeaseStorePort } from '../../../src/coordination-lease/lease-store-port.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import {
  EPOCH_MS,
  EPOCH_UTC,
  FOREIGN_OWNER,
  OTHER_MANIFEST_SHA,
  RUN_OWNER,
  storedLeaseItem,
} from '../../support/coordination-lease/lease-fixtures.ts';
import { RacingWriteItemStore } from '../../support/coordination-lease/racing-write-item-store.ts';
import { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

const LATER = '2026-10-05T12:00:30.000Z' as UtcMillis;
const PAST = '2020-01-01T00:00:00.000Z' as UtcMillis;

interface StoreUnderTest {
  readonly items: InMemoryItemStore;
  readonly racing: RacingWriteItemStore;
  readonly lease: LeaseStorePort;
}

function storeUnderTest(seed?: LeaseItem): StoreUnderTest {
  const items = new InMemoryItemStore({ clock: new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS }) });
  if (seed !== undefined) {
    items.seed('coordination', toStoredItem(seed));
  }
  const racing = new RacingWriteItemStore(items);
  return { items, racing, lease: createDurableLeaseStore(racing) };
}

function stored(subject: StoreUnderTest): unknown {
  return subject.items.peek('coordination', LEASE_ITEM_KEY);
}

function held(status: LeaseItemStatus = 'HELD', version = 3): LeaseItem {
  return { ...acquiredLeaseItem(RUN_OWNER, EPOCH_UTC), lease_status: status, lease_version: version };
}

describe('createDurableLeaseStore acquire', () => {
  it('puts a fresh held item on the coordination table when none exists', async () => {
    const subject = storeUnderTest();
    assert.deepEqual(await subject.lease.acquire(RUN_OWNER, EPOCH_UTC), { kind: 'applied' });
    assert.deepEqual(stored(subject), acquiredLeaseItem(RUN_OWNER, EPOCH_UTC));
    assert.deepEqual(subject.racing.writes(), [
      {
        kind: 'put',
        table: 'coordination',
        item: acquiredLeaseItem(RUN_OWNER, EPOCH_UTC),
        condition: { kind: 'item_absent' },
      },
    ]);
  });

  it('is refused by a held item, with the item as it was', async () => {
    const foreign = acquiredLeaseItem(FOREIGN_OWNER, EPOCH_UTC);
    const subject = storeUnderTest(foreign);
    assert.deepEqual(await subject.lease.acquire(RUN_OWNER, LATER), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: foreign,
    });
    assert.deepEqual(stored(subject), foreign);
    assert.equal(subject.racing.writes().length, 1);
  });

  it('is refused by a held item whose expiry lies in the past (TTL expiry is not release)', async () => {
    const expired = { ...acquiredLeaseItem(FOREIGN_OWNER, PAST), expires_at: PAST };
    const subject = storeUnderTest(expired);
    assert.equal((await subject.lease.acquire(RUN_OWNER, EPOCH_UTC)).kind, 'condition_failed');
    assert.deepEqual(stored(subject), expired);
    assert.equal(subject.racing.writes().length, 1);
  });

  it('is refused by a recovery-required item', async () => {
    const subject = storeUnderTest({ ...acquiredLeaseItem(FOREIGN_OWNER, PAST), lease_status: 'RECOVERY_REQUIRED' });
    assert.equal((await subject.lease.acquire(RUN_OWNER, EPOCH_UTC)).kind, 'condition_failed');
    assert.equal(subject.racing.writes().length, 1);
  });

  it('is refused by an item that does not decode, without a second put', async () => {
    const subject = storeUnderTest();
    subject.items.seed('coordination', { ...LEASE_ITEM_KEY, lease_status: 'RELEASED' });
    assert.equal((await subject.lease.acquire(RUN_OWNER, EPOCH_UTC)).kind, 'condition_failed');
    assert.equal(subject.racing.writes().length, 1);
  });

  it('replaces an explicitly released item with a second put conditioned on that exact item', async () => {
    const released: LeaseItem = {
      ...acquiredLeaseItem(FOREIGN_OWNER, PAST),
      lease_status: 'RELEASED',
      lease_version: 9,
    };
    const subject = storeUnderTest(released);
    assert.deepEqual(await subject.lease.acquire(RUN_OWNER, EPOCH_UTC), { kind: 'applied' });
    assert.deepEqual(stored(subject), acquiredLeaseItem(RUN_OWNER, EPOCH_UTC));
    assert.deepEqual(subject.racing.writes()[1], {
      kind: 'put',
      table: 'coordination',
      item: acquiredLeaseItem(RUN_OWNER, EPOCH_UTC),
      condition: {
        kind: 'all',
        conditions: [
          { kind: 'attribute_equals', name: 'lease_status', value: 'RELEASED' },
          { kind: 'attribute_equals', name: 'lease_version', value: 9 },
          { kind: 'attribute_equals', name: 'owner_id', value: FOREIGN_OWNER.owner_id },
        ],
      },
    });
  });

  it('lets only one of two owners racing for a released lease win', async () => {
    const released: LeaseItem = { ...acquiredLeaseItem(FOREIGN_OWNER, PAST), lease_status: 'RELEASED' };
    const subject = storeUnderTest(released);
    const winner = { ...acquiredLeaseItem(FOREIGN_OWNER, EPOCH_UTC), owner_manifest_sha256: OTHER_MANIFEST_SHA };
    subject.racing.afterWrite(1, async (inner) => {
      await inner.write({ kind: 'put', table: 'coordination', item: toStoredItem(winner) });
    });
    assert.deepEqual(await subject.lease.acquire(RUN_OWNER, EPOCH_UTC), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: winner,
    });
    assert.deepEqual(stored(subject), winner);
  });

  it('returns a definitive failure of the first put without a second one', async () => {
    const subject = storeUnderTest();
    subject.items.scriptWriteFault({ kind: 'definitive_failure', code: 'AccessDeniedException' });
    assert.deepEqual(await subject.lease.acquire(RUN_OWNER, EPOCH_UTC), {
      kind: 'definitive_failure',
      code: 'AccessDeniedException',
    });
    assert.equal(subject.racing.writes().length, 1);
  });
});

describe('createDurableLeaseStore heartbeat', () => {
  it('raises the version and moves heartbeat, expiry and update instants', async () => {
    const subject = storeUnderTest(held());
    assert.deepEqual(await subject.lease.heartbeat(RUN_OWNER, 3, LATER), { kind: 'applied' });
    assert.deepEqual(stored(subject), {
      ...held(),
      lease_version: 4,
      heartbeat_at: LATER,
      expires_at: '2026-10-05T12:05:30.000Z',
      updated_at: LATER,
    });
    assert.deepEqual(subject.racing.writes()[0], {
      kind: 'update',
      table: 'coordination',
      key: LEASE_ITEM_KEY,
      set: { heartbeat_at: LATER, expires_at: '2026-10-05T12:05:30.000Z', updated_at: LATER, lease_version: 4 },
      condition: {
        kind: 'all',
        conditions: [
          { kind: 'attribute_equals', name: 'owner_kind', value: 'RUN' },
          { kind: 'attribute_equals', name: 'owner_id', value: RUN_OWNER.owner_id },
          { kind: 'attribute_equals', name: 'owner_manifest_sha256', value: RUN_OWNER.owner_manifest_sha256 },
          { kind: 'attribute_equals', name: 'lease_version', value: 3 },
          { kind: 'attribute_in', name: 'lease_status', values: ['HELD'] },
        ],
      },
    });
  });

  it('fails on another version, owner kind, owner id or manifest digest', async () => {
    const attempts = [
      { owner: RUN_OWNER, version: 2 },
      { owner: { ...RUN_OWNER, owner_kind: 'TRANSPORT_PROBE' as const }, version: 3 },
      { owner: { ...RUN_OWNER, owner_id: FOREIGN_OWNER.owner_id }, version: 3 },
      { owner: { ...RUN_OWNER, owner_manifest_sha256: OTHER_MANIFEST_SHA }, version: 3 },
    ];
    for (const attempt of attempts) {
      const subject = storeUnderTest(held());
      const outcome = await subject.lease.heartbeat(attempt.owner, attempt.version, LATER);
      assert.deepEqual(outcome, { kind: 'condition_failed', failed_action_index: 0, existing: held() });
      assert.deepEqual(stored(subject), held());
    }
  });

  it('fails on a released or recovery-required item', async () => {
    for (const status of ['RELEASED', 'RECOVERY_REQUIRED'] as const) {
      const subject = storeUnderTest(held(status));
      assert.equal((await subject.lease.heartbeat(RUN_OWNER, 3, LATER)).kind, 'condition_failed');
    }
  });

  it('fails on an absent item and creates none', async () => {
    const subject = storeUnderTest();
    assert.equal((await subject.lease.heartbeat(RUN_OWNER, 1, LATER)).kind, 'condition_failed');
    assert.equal(stored(subject), undefined);
  });
});

describe('createDurableLeaseStore release and markRecoveryRequired', () => {
  it('releases a held or recovery-required item of this owner', async () => {
    for (const status of ['HELD', 'RECOVERY_REQUIRED'] as const) {
      const subject = storeUnderTest(held(status));
      assert.deepEqual(await subject.lease.release(RUN_OWNER, 3, LATER), { kind: 'applied' });
      assert.deepEqual(stored(subject), { ...held(), lease_status: 'RELEASED', lease_version: 4, updated_at: LATER });
    }
  });

  it('never releases an already released item or another owner item', async () => {
    const released = storeUnderTest(held('RELEASED'));
    assert.equal((await released.lease.release(RUN_OWNER, 3, LATER)).kind, 'condition_failed');
    const foreign = storeUnderTest({ ...held(), owner_id: FOREIGN_OWNER.owner_id });
    assert.equal((await foreign.lease.release(RUN_OWNER, 3, LATER)).kind, 'condition_failed');
  });

  it('marks a held item recovery required, and nothing else', async () => {
    const subject = storeUnderTest(held());
    assert.deepEqual(await subject.lease.markRecoveryRequired(RUN_OWNER, 3, LATER), { kind: 'applied' });
    assert.deepEqual(stored(subject), {
      ...held(),
      lease_status: 'RECOVERY_REQUIRED',
      lease_version: 4,
      updated_at: LATER,
    });
    for (const status of ['RELEASED', 'RECOVERY_REQUIRED'] as const) {
      const other = storeUnderTest(held(status));
      assert.equal((await other.lease.markRecoveryRequired(RUN_OWNER, 3, LATER)).kind, 'condition_failed');
    }
  });
});

describe('createDurableLeaseStore read', () => {
  it('returns undefined when no lease item exists', async () => {
    assert.deepEqual(await storeUnderTest().lease.read(), { ok: true, value: undefined });
  });

  it('returns the decoded item', async () => {
    assert.deepEqual(await storeUnderTest(held()).lease.read(), { ok: true, value: held() });
  });

  it('names a failed consistent read', async () => {
    const subject = storeUnderTest(held());
    subject.items.scriptReadFault('InternalServerError', { operation: 'getConsistent', table: 'coordination' });
    assert.deepEqual(await subject.lease.read(), {
      ok: false,
      error: { code: 'LEASE_READ_FAILED', detail: 'consistent read failed with InternalServerError' },
    });
  });

  it('refuses an item that does not decode', async () => {
    const subject = storeUnderTest();
    subject.items.seed('coordination', storedLeaseItem(RUN_OWNER, EPOCH_UTC, { lease_version: 0 }));
    assert.deepEqual(await subject.lease.read(), {
      ok: false,
      error: {
        code: 'LEASE_ITEM_UNDECODABLE',
        detail: 'lease item member lease_version is number 0; expected a positive safe integer',
      },
    });
  });
});
