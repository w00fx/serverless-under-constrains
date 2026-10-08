// The lease store over the durable item store's baseline `coordination` table ([R-aws] §1.2):
// - acquire: a put conditioned on an absent item; when that fails on an explicitly released
//   item, a second put conditioned on that exact released item (status, version and owner),
//   because the store's condition vocabulary has no OR. Two owners racing for one released
//   lease cannot both win: the second put of the loser fails on the winner's item;
// - heartbeat, release and recovery: one update conditioned on this owner (kind, id, manifest
//   digest), the expected version and the permitted statuses; each raises the version by one;
// - read: one strongly consistent point read, decoded totally.
// A held item whose `expires_at` lies in the past is still held: nothing here reads the
// expiry, and the table has no TTL (AC-RUA-033).

import type { Condition, DurableItemStore, WriteOutcome } from '../durable-store/item-store-port.ts';
import type { Result, UtcMillis } from '../record-contract/primitives.ts';
import type { LeaseItem, LeaseItemStatus, LeaseOwner } from './lease-item.ts';
import {
  LEASE_ITEM_KEY,
  LEASE_REASON_CODES,
  acquiredLeaseItem,
  decodeLeaseItem,
  isLeaseAvailable,
  leaseExpiry,
  toStoredItem,
} from './lease-item.ts';
import type { LeaseReadFailure, LeaseStorePort } from './lease-store-port.ts';

const TABLE = 'coordination';

/**
 * Binds the lease store port to the coordination table of `store`.
 *
 * @example
 * const leaseStore = createDurableLeaseStore(createDynamoDbItemStore(tables, client));
 * await leaseStore.acquire(owner, at); // { kind: 'applied' } when no other owner holds the lease
 */
export function createDurableLeaseStore(store: DurableItemStore): LeaseStorePort {
  return {
    acquire: (owner, at) => acquireLease(store, owner, at),
    heartbeat: (owner, expectedVersion, at) =>
      updateOwnedLease(store, owner, expectedVersion, ['HELD'], {
        heartbeat_at: at,
        expires_at: leaseExpiry(at),
        updated_at: at,
      }),
    release: (owner, expectedVersion, at) =>
      updateOwnedLease(store, owner, expectedVersion, ['HELD', 'RECOVERY_REQUIRED'], {
        lease_status: 'RELEASED',
        updated_at: at,
      }),
    markRecoveryRequired: (owner, expectedVersion, at) =>
      updateOwnedLease(store, owner, expectedVersion, ['HELD'], {
        lease_status: 'RECOVERY_REQUIRED',
        updated_at: at,
      }),
    read: () => readLease(store),
  };
}

async function acquireLease(store: DurableItemStore, owner: LeaseOwner, at: UtcMillis): Promise<WriteOutcome> {
  const item = toStoredItem(acquiredLeaseItem(owner, at));
  const first = await store.write({ kind: 'put', table: TABLE, item, condition: { kind: 'item_absent' } });
  const released = releasedHolder(first);
  if (released === undefined) {
    return first;
  }
  return store.write({ kind: 'put', table: TABLE, item, condition: sameReleasedItem(released) });
}

// The released item a failed `item_absent` put returned, when it decodes as released.
function releasedHolder(outcome: WriteOutcome): LeaseItem | undefined {
  if (outcome.kind !== 'condition_failed' || outcome.existing === undefined) {
    return undefined;
  }
  const decoded = decodeLeaseItem(outcome.existing);
  return decoded.ok && isLeaseAvailable(decoded.value) ? decoded.value : undefined;
}

function sameReleasedItem(released: LeaseItem): Condition {
  return {
    kind: 'all',
    conditions: [
      { kind: 'attribute_equals', name: 'lease_status', value: 'RELEASED' },
      { kind: 'attribute_equals', name: 'lease_version', value: released.lease_version },
      { kind: 'attribute_equals', name: 'owner_id', value: released.owner_id },
    ],
  };
}

function updateOwnedLease(
  store: DurableItemStore,
  owner: LeaseOwner,
  expectedVersion: number,
  statuses: readonly LeaseItemStatus[],
  set: Readonly<Record<string, string>>,
): Promise<WriteOutcome> {
  return store.write({
    kind: 'update',
    table: TABLE,
    key: LEASE_ITEM_KEY,
    set: { ...set, lease_version: expectedVersion + 1 },
    condition: ownedAt(owner, expectedVersion, statuses),
  });
}

function ownedAt(owner: LeaseOwner, version: number, statuses: readonly LeaseItemStatus[]): Condition {
  return {
    kind: 'all',
    conditions: [
      { kind: 'attribute_equals', name: 'owner_kind', value: owner.owner_kind },
      { kind: 'attribute_equals', name: 'owner_id', value: owner.owner_id },
      { kind: 'attribute_equals', name: 'owner_manifest_sha256', value: owner.owner_manifest_sha256 },
      { kind: 'attribute_equals', name: 'lease_version', value: version },
      { kind: 'attribute_in', name: 'lease_status', values: statuses },
    ],
  };
}

async function readLease(store: DurableItemStore): Promise<Result<LeaseItem | undefined, LeaseReadFailure>> {
  const read = await store.getConsistent(TABLE, LEASE_ITEM_KEY);
  if (!read.ok) {
    return {
      ok: false,
      error: { code: LEASE_REASON_CODES.readFailed, detail: `consistent read failed with ${read.error.code}` },
    };
  }
  if (read.value === undefined) {
    return { ok: true, value: undefined };
  }
  const decoded = decodeLeaseItem(read.value);
  return decoded.ok ? decoded : { ok: false, error: { code: decoded.error.code, detail: decoded.error.detail } };
}
