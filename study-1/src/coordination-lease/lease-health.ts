// The pure lease-health state machine of BR-RUA-045 (design §10.3):
//
//   CONFIRMED --heartbeat fails--> UNCERTAIN --confirmed before the stale boundary--> CONFIRMED
//   any held state --ownership mismatch--> LOST_OWNERSHIP_MISMATCH
//   any held state --300 s since the last confirmed heartbeat--> LOST_STALE
//
// Both losses are absorbing. Elapsed time is measured on the session's monotonic clock and
// never on wall time (RF V3/V4), and a confirmation counts from the moment its write was
// issued, so the boundary is never later than the store's own heartbeat. A confirmation that
// completes at or after the boundary does not resume scheduling: staleness is judged first.

import type { LeaseEvent, LeaseHealth } from '../record-contract/records/group-b/vocabulary.ts';
import type { LeaseStatus } from '../record-contract/records/group-c/vocabulary.ts';
import type { UtcMillis } from '../record-contract/primitives.ts';
import { LEASE_STALE_BOUNDARY_MS } from './lease-item.ts';

/** BR-RUA-045 heartbeat interval. */
export const LEASE_HEARTBEAT_INTERVAL_MS = 30_000;

const NS_PER_MS = 1_000_000n;
/** The stale boundary in monotonic nanoseconds. */
export const LEASE_STALE_BOUNDARY_NS = BigInt(LEASE_STALE_BOUNDARY_MS) * NS_PER_MS;

export interface LeaseHealthState {
  readonly health: LeaseHealth;
  readonly lease_version: number;
  /** Monotonic reading when the last confirmed write was issued. */
  readonly last_confirmed_ns: bigint;
  /** Wall time of the last confirmed write, for the journal. */
  readonly last_confirmed_at: UtcMillis;
}

/**
 * What one heartbeat, or one look at the clock, established:
 * - `confirmed`: the conditional heartbeat applied (issued at `issued_ns`, answered at `observed_ns`);
 * - `failed`: ownership was not confirmed but not refuted either (transient, definitive or
 *   unresolved ambiguous failure); `adopted_version` is the version the store shows when an
 *   earlier write of this owner landed unseen;
 * - `mismatch`: the store shows the lease is not, or no longer, held by this owner (`code` says how);
 * - `clock`: only time passed.
 */
export type LeaseObservation =
  | {
      readonly kind: 'confirmed';
      readonly issued_ns: bigint;
      readonly observed_ns: bigint;
      readonly at: UtcMillis;
      readonly lease_version: number;
    }
  | { readonly kind: 'failed'; readonly observed_ns: bigint; readonly adopted_version?: number }
  | { readonly kind: 'mismatch'; readonly observed_ns: bigint; readonly code: string }
  | { readonly kind: 'clock'; readonly observed_ns: bigint };

/**
 * The health after an observation. Losses are absorbing; staleness is judged before anything
 * else, so no observation at or past the boundary keeps the lease.
 *
 * @example
 * nextLeaseHealth(confirmedState, { kind: 'failed', observed_ns: 60_000_000_000n }).health; // 'UNCERTAIN'
 */
export function nextLeaseHealth(state: LeaseHealthState, observation: LeaseObservation): LeaseHealthState {
  if (isLost(state.health)) {
    return state;
  }
  if (observation.observed_ns - state.last_confirmed_ns >= LEASE_STALE_BOUNDARY_NS) {
    return { ...state, health: 'LOST_STALE' };
  }
  switch (observation.kind) {
    case 'confirmed':
      return {
        health: 'CONFIRMED',
        lease_version: observation.lease_version,
        last_confirmed_ns: observation.issued_ns,
        last_confirmed_at: observation.at,
      };
    case 'failed':
      return { ...state, health: 'UNCERTAIN', lease_version: observation.adopted_version ?? state.lease_version };
    case 'mismatch':
      return { ...state, health: 'LOST_OWNERSHIP_MISMATCH' };
    case 'clock':
      return state;
  }
}

/**
 * Whether the health is a loss (ownership mismatch or staleness).
 *
 * @example
 * isLost('UNCERTAIN'); // false
 */
export function isLost(health: LeaseHealth): boolean {
  return health === 'LOST_OWNERSHIP_MISMATCH' || health === 'LOST_STALE';
}

/**
 * Whether new publication may start: only while ownership is confirmed and the last
 * confirmation is younger than the stale boundary (a stopped heartbeat cannot keep it open).
 *
 * @example
 * isPublicationAllowed(uncertainState, nowNs); // false: uncertainty blocks new publication
 */
export function isPublicationAllowed(state: LeaseHealthState, nowNs: bigint): boolean {
  return state.health === 'CONFIRMED' && nowNs - state.last_confirmed_ns < LEASE_STALE_BOUNDARY_NS;
}

/**
 * Milliseconds until the next heartbeat: the interval, or, while uncertain, no later than the
 * stale boundary, so staleness is established at the boundary rather than up to one interval
 * after it.
 *
 * @example
 * heartbeatDelayMs(uncertainState, nowNs); // 30000, or less when the boundary is nearer
 */
export function heartbeatDelayMs(state: LeaseHealthState, nowNs: bigint): number {
  if (state.health !== 'UNCERTAIN') {
    return LEASE_HEARTBEAT_INTERVAL_MS;
  }
  const remainingNs = state.last_confirmed_ns + LEASE_STALE_BOUNDARY_NS - nowNs;
  const remainingMs = Number((remainingNs + NS_PER_MS - 1n) / NS_PER_MS);
  return Math.max(0, Math.min(LEASE_HEARTBEAT_INTERVAL_MS, remainingMs));
}

const FINAL_STATUS_OF_EVENT: Readonly<Partial<Record<LeaseEvent, LeaseStatus>>> = {
  RELEASED: 'released',
  RECOVERY_REQUIRED: 'recovery_required',
  RELEASE_FAILED: 'unverified',
  STATE_UNVERIFIED: 'unverified',
};

/**
 * The BR-RUA-045 final lease status of a lease-event history: the last release, recovery or
 * unverified-state event decides; without one, release was never established (TTL expiry
 * never establishes release), so the status is `unverified`.
 *
 * @example
 * deriveFinalLeaseStatus(['ACQUIRED', 'HEARTBEAT_CONFIRMED', 'RELEASED']); // 'released'
 * deriveFinalLeaseStatus(['ACQUIRED', 'LOST_STALE']); // 'unverified'
 */
export function deriveFinalLeaseStatus(events: readonly LeaseEvent[]): LeaseStatus {
  const settled = events.map((event) => FINAL_STATUS_OF_EVENT[event]).filter((status) => status !== undefined);
  return settled.at(-1) ?? 'unverified';
}
