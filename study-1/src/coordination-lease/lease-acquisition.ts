// What one acquisition write established (BR-RUA-045, BR-RUA-046 "an active conflicting
// lease"; design §10.2 P1):
// - applied: acquired;
// - condition failed: refused. The item as it was (ALL_OLD) names the holder. A held item
//   whose `expires_at` lies in the past still refuses: TTL expiry never establishes release;
// - definitively rejected: refused, nothing written;
// - ambiguous: a consistent read decides. The put landed when the item names this owner, held
//   at version 1, acquired at this instant. Any other item, or none, means it did not land.
//   When the read fails as well the acquisition stays unresolved: the lease may be held by this
//   owner, so finalization must still try to release it.

import type { StoredItem, WriteOutcome } from '../durable-store/item-store-port.ts';
import type { StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { LeaseItem, LeaseOwner } from './lease-item.ts';
import { LEASE_REASON_CODES, decodeLeaseItem, describeHolder, isOwnedBy, leaseReason } from './lease-item.ts';
import type { LeaseStorePort } from './lease-store-port.ts';

export type AcquisitionResolution =
  | { readonly kind: 'acquired'; readonly detail: string }
  | {
      readonly kind: 'refused' | 'unresolved';
      readonly holder?: LeaseItem;
      readonly reason: StructuredReason;
    };

/**
 * Resolves the outcome of an acquisition write for `owner` at `at`.
 *
 * @example
 * const resolution = await resolveAcquisition(store, owner, at, await store.acquire(owner, at));
 * resolution.kind; // 'acquired' | 'refused' | 'unresolved'
 */
export async function resolveAcquisition(
  store: LeaseStorePort,
  owner: LeaseOwner,
  at: UtcMillis,
  outcome: WriteOutcome,
): Promise<AcquisitionResolution> {
  switch (outcome.kind) {
    case 'applied':
      return { kind: 'acquired', detail: 'conditional acquisition applied' };
    case 'definitive_failure':
      return refused(LEASE_REASON_CODES.writeRejected, `acquisition rejected with ${outcome.code}; nothing written`);
    case 'condition_failed':
      return refusedByExisting(outcome.existing);
    case 'ambiguous':
      return resolveAmbiguous(store, owner, at, outcome.code);
  }
}

function refusedByExisting(existing: StoredItem | undefined): AcquisitionResolution {
  if (existing === undefined) {
    return refused(LEASE_REASON_CODES.conflict, 'a lease item exists but the store could not return it');
  }
  const decoded = decodeLeaseItem(existing);
  if (!decoded.ok) {
    return refused(decoded.error.code, `acquisition refused: ${decoded.error.detail}`);
  }
  return conflict(decoded.value, 'acquisition refused');
}

async function resolveAmbiguous(
  store: LeaseStorePort,
  owner: LeaseOwner,
  at: UtcMillis,
  code: string,
): Promise<AcquisitionResolution> {
  const read = await store.read();
  const context = `ambiguous acquisition (${code})`;
  if (!read.ok) {
    return {
      kind: 'unresolved',
      reason: leaseReason(
        LEASE_REASON_CODES.writeAmbiguous,
        `${context}; the resolving read failed: ${read.error.detail}`,
      ),
    };
  }
  const item = read.value;
  if (item === undefined) {
    return refused(LEASE_REASON_CODES.writeAmbiguous, `${context}; the lease item is absent, so the put did not land`);
  }
  if (acquisitionLanded(item, owner, at)) {
    return { kind: 'acquired', detail: `${context} confirmed by a consistent read` };
  }
  return conflict(item, `${context} did not land`);
}

function acquisitionLanded(item: LeaseItem, owner: LeaseOwner, at: UtcMillis): boolean {
  return isOwnedBy(item, owner) && item.lease_status === 'HELD' && item.lease_version === 1 && item.acquired_at === at;
}

function conflict(holder: LeaseItem, context: string): AcquisitionResolution {
  return {
    kind: 'refused',
    holder,
    reason: leaseReason(
      LEASE_REASON_CODES.conflict,
      `${context}: the item shows ${describeHolder(holder)}; expected no item or a RELEASED one (an expiry never releases)`,
    ),
  };
}

function refused(code: string, detail: string): AcquisitionResolution {
  return { kind: 'refused', reason: leaseReason(code, detail) };
}
