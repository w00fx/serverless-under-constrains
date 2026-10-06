// Lease finalization (BR-RUA-045; design §10.2 P8, §10.3): "Clean original closure
// conditionally releases the lease before summary and package finalization. Incomplete
// cleanup or non-clean audit transitions to recovery where possible."
//
// A consistent read comes first, because the version may have moved under an ambiguous
// heartbeat and a lost session may no longer own the item:
// - the item names this owner: an already released item is released; a recovery-required item
//   stays so on an unclean closure; otherwise the conditional write (release when clean,
//   recovery when unclean) runs at the version the item shows;
// - the item is absent or names another owner: a session that held the lease cannot establish
//   release (an absent item, for example after TTL deletion, never proves it), so the state is
//   unverified; a session whose acquisition never landed held nothing, so nothing is left held;
// - the read fails: the write runs at the version the session knows, and its outcome decides.
// An ambiguous write is resolved by a second consistent read; a definitive or conditional
// failure of a release is RELEASE_FAILED, and any other unresolved outcome STATE_UNVERIFIED.

import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import type { UtcMillis } from '../record-contract/primitives.ts';
import type { LeaseEvent } from '../record-contract/records/group-b/vocabulary.ts';
import type { LeaseItem, LeaseItemStatus, LeaseOwner } from './lease-item.ts';
import { decodeLeaseItem, describeHolder, isOwnedBy } from './lease-item.ts';
import type { LeaseStorePort } from './lease-store-port.ts';

// The statuses a finalization writes; each is also the name of its lease event.
type FinalItemStatus = Extract<LeaseItemStatus, 'RELEASED' | 'RECOVERY_REQUIRED'>;

/** Whether cleanup succeeded and the leak audit was clean (the original closure). */
export type LeaseClosure = 'clean' | 'unclean';

export interface FinalizationRequest {
  readonly store: LeaseStorePort;
  readonly owner: LeaseOwner;
  readonly closure: LeaseClosure;
  /** The version the session last knew. */
  readonly known_version: number;
  /** False when the acquisition stayed unresolved: the lease may never have been held. */
  readonly held: boolean;
  readonly now: () => UtcMillis;
}

export interface FinalizationVerdict {
  readonly lease_event: LeaseEvent;
  /** The version after the transition, when the store showed or applied one. */
  readonly lease_version?: number;
  readonly observed?: LeaseItem;
  readonly detail: string;
}

/**
 * Finalizes the lease of a session that held it, or whose acquisition stayed unresolved.
 *
 * @example
 * const verdict = await finalizeLease({ store, owner, closure: 'clean', known_version: 7, held: true, now });
 * verdict.lease_event; // 'RELEASED' after a conditional release applied
 */
export async function finalizeLease(request: FinalizationRequest): Promise<FinalizationVerdict> {
  const read = await request.store.read();
  if (!read.ok) {
    return writeFinal(request, request.known_version, `the pre-finalization read failed: ${read.error.detail}`);
  }
  const item = read.value;
  if (item === undefined || !isOwnedBy(item, request.owner)) {
    return notOwned(request, item);
  }
  if (item.lease_status === 'RELEASED') {
    return { lease_event: 'RELEASED', lease_version: item.lease_version, observed: item, detail: 'already released' };
  }
  if (item.lease_status === 'RECOVERY_REQUIRED' && request.closure === 'unclean') {
    return {
      lease_event: 'RECOVERY_REQUIRED',
      lease_version: item.lease_version,
      observed: item,
      detail: 'already marked recovery required',
    };
  }
  return writeFinal(request, item.lease_version, `the item shows ${describeHolder(item)}`);
}

function notOwned(request: FinalizationRequest, item: LeaseItem | undefined): FinalizationVerdict {
  const shown = item === undefined ? 'the lease item is absent' : `the item shows ${describeHolder(item)}`;
  const observed = item === undefined ? {} : { observed: item };
  if (!request.held) {
    return {
      lease_event: 'RELEASED',
      ...observed,
      detail: `the unresolved acquisition never landed (${shown}); this owner holds nothing`,
    };
  }
  return {
    lease_event: 'STATE_UNVERIFIED',
    ...observed,
    detail: `${shown}; release cannot be established (TTL expiry or absence never proves release)`,
  };
}

async function writeFinal(
  request: FinalizationRequest,
  version: number,
  context: string,
): Promise<FinalizationVerdict> {
  const target: FinalItemStatus = request.closure === 'clean' ? 'RELEASED' : 'RECOVERY_REQUIRED';
  const at = request.now();
  const outcome =
    request.closure === 'clean'
      ? await request.store.release(request.owner, version, at)
      : await request.store.markRecoveryRequired(request.owner, version, at);
  const written = `${context}; conditional ${target} write at version ${String(version)}`;
  switch (outcome.kind) {
    case 'applied':
      return { lease_event: target, lease_version: version + 1, detail: `${written} applied` };
    case 'ambiguous':
      return resolveAmbiguous(request, target, `${written} was ambiguous (${outcome.code})`);
    case 'condition_failed':
    case 'definitive_failure':
      return {
        ...writeFailure(request.closure, `${written} failed: ${describeFailure(outcome)}`),
        ...observedOf(outcome),
      };
  }
}

async function resolveAmbiguous(
  request: FinalizationRequest,
  target: FinalItemStatus,
  context: string,
): Promise<FinalizationVerdict> {
  const read = await request.store.read();
  if (!read.ok) {
    return { lease_event: 'STATE_UNVERIFIED', detail: `${context}; the resolving read failed: ${read.error.detail}` };
  }
  const item = read.value;
  if (item !== undefined && isOwnedBy(item, request.owner) && item.lease_status === target) {
    return {
      lease_event: target,
      lease_version: item.lease_version,
      observed: item,
      detail: `${context}; a consistent read confirms it`,
    };
  }
  const shown = item === undefined ? 'the lease item is absent' : `the item shows ${describeHolder(item)}`;
  return {
    lease_event: 'STATE_UNVERIFIED',
    ...(item === undefined ? {} : { observed: item }),
    detail: `${context}; ${shown}`,
  };
}

function writeFailure(closure: LeaseClosure, detail: string): FinalizationVerdict {
  return { lease_event: closure === 'clean' ? 'RELEASE_FAILED' : 'STATE_UNVERIFIED', detail };
}

function describeFailure(outcome: Extract<WriteOutcome, { kind: 'condition_failed' | 'definitive_failure' }>): string {
  return outcome.kind === 'definitive_failure' ? outcome.code : 'the ownership condition did not hold';
}

function observedOf(outcome: WriteOutcome): { readonly observed?: LeaseItem } {
  if (outcome.kind !== 'condition_failed' || outcome.existing === undefined) {
    return {};
  }
  const decoded = decodeLeaseItem(outcome.existing);
  return decoded.ok ? { observed: decoded.value } : {};
}
