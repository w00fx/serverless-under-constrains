// The record-specific body of one `lease_event_recorded` (catalogue group B row 55): the
// transition, this owner, and, when known, the lease version, the health after the
// transition, the last confirmed heartbeat and a foreign holder (named as a pair, never half
// of one). Optional members are omitted when unknown (BR-RUA-033), and the detail is cut to
// the kernel bound because it may quote values read from the store (A-05).

import type { EventBody } from '../event-journal/journal-event.ts';
import { boundedText } from '../record-contract/json-value.ts';
import type { LeaseEvent } from '../record-contract/records/group-b/vocabulary.ts';
import type { LeaseHealthState } from './lease-health.ts';
import type { LeaseItem, LeaseOwner } from './lease-item.ts';
import { isOwnedBy } from './lease-item.ts';

/** The most characters of detail one lease event carries. */
export const LEASE_EVENT_DETAIL_LIMIT = 400;

export interface LeaseEventFacts {
  readonly lease_event: LeaseEvent;
  readonly owner: LeaseOwner;
  /** The session state after the transition; absent before any ownership was established. */
  readonly state?: LeaseHealthState;
  /** The item the store showed; named as the holder only when another owner holds it. */
  readonly observed?: LeaseItem;
  readonly detail?: string;
}

/**
 * Builds the body of a lease event.
 *
 * @example
 * await journal.append('lease_event_recorded', leaseEventBody({ lease_event: 'ACQUIRED', owner, state }));
 */
export function leaseEventBody(facts: LeaseEventFacts): EventBody<'lease_event_recorded'> {
  const { state, observed, detail } = facts;
  const holder = observed !== undefined && !isOwnedBy(observed, facts.owner) ? observed : undefined;
  return {
    lease_event: facts.lease_event,
    owner_kind: facts.owner.owner_kind,
    owner_id: facts.owner.owner_id,
    owner_manifest_sha256: facts.owner.owner_manifest_sha256,
    ...(state === undefined
      ? {}
      : {
          lease_version: state.lease_version,
          lease_health: state.health,
          last_confirmed_at: state.last_confirmed_at,
        }),
    ...(holder === undefined ? {} : { holder_owner_kind: holder.owner_kind, holder_owner_id: holder.owner_id }),
    ...(detail === undefined || detail.length === 0 ? {} : { detail: boundedText(detail, LEASE_EVENT_DETAIL_LIMIT) }),
  };
}
