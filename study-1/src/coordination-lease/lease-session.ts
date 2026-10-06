// One owner's coordination lease for one execution (BR-RUA-045; design §5.3, §10.2 P1/P8,
// §10.3). Acquisition is the execution's first mutation; heartbeats keep ownership confirmed;
// a first failed heartbeat enters uncertainty and blocks new publication at once; a
// confirmation before the 300 s stale boundary resumes scheduling; ownership mismatch or
// staleness is a loss, which stops experimental work (the heartbeat loop reports it so the
// runner interrupts and begins emergency cleanup); finalization releases on a clean closure
// and marks recovery on an unclean one. TTL never takes part: the store has none and nothing
// here reads the informational expiry as a release.
//
// Every transition is journaled as `lease_event_recorded` through the injected coordination
// journal writer (source `coordination_lease`, execution partition). A stopped writer keeps
// its own stop reason (`isStopped()`); the lease logic does not depend on journal success.
// Operations are serialized, so a heartbeat in flight finishes before finalization starts.
// The store is used through `guardLeaseStore`: a store call that throws counts as an ambiguous
// write or a failed read, so `heartbeatOnce` never rejects while the lease is held (the
// heartbeat loop relies on that to end quietly only once nothing is held).

import type { JournalWriter } from '../event-journal/journal-writer.ts';
import type { MonotonicClock, StructuredReason, UtcMillis, WallClock } from '../record-contract/primitives.ts';
import type { LeaseEvent, LeaseHealth } from '../record-contract/records/group-b/vocabulary.ts';
import type { LeaseStatus } from '../record-contract/records/group-c/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { guardLeaseStore } from './guarded-lease-store.ts';
import type { HeartbeatJudgement } from './heartbeat-judgement.ts';
import { judgeHeartbeat } from './heartbeat-judgement.ts';
import { resolveAcquisition } from './lease-acquisition.ts';
import { leaseEventBody } from './lease-event-body.ts';
import type { LeaseEventFacts } from './lease-event-body.ts';
import { finalizeLease } from './lease-finalization.ts';
import type { LeaseClosure } from './lease-finalization.ts';
import type { LeaseHealthState, LEASE_HEARTBEAT_INTERVAL_MS } from './lease-health.ts';
import {
  LEASE_STALE_BOUNDARY_NS,
  deriveFinalLeaseStatus,
  heartbeatDelayMs,
  isLost,
  isPublicationAllowed,
  nextLeaseHealth,
} from './lease-health.ts';
import type { LeaseItem, LeaseOwner, LEASE_STALE_BOUNDARY_MS } from './lease-item.ts';
import { LEASE_REASON_CODES, leaseReason } from './lease-item.ts';
import type { LeaseStorePort } from './lease-store-port.ts';

export interface LeaseSessionDeps {
  readonly store: LeaseStorePort;
  readonly monotonic: MonotonicClock;
  readonly wall: WallClock;
  /** The coordination journal writer: source `coordination_lease`, execution partition. */
  readonly journal: JournalWriter;
  /**
   * BR-RUA-045 fixes the interval and the boundary; the literal types make the composition root
   * state them (design §5.3) without letting any other value through.
   */
  readonly heartbeatIntervalMs: typeof LEASE_HEARTBEAT_INTERVAL_MS;
  readonly staleBoundaryMs: typeof LEASE_STALE_BOUNDARY_MS;
}

export type LeaseAcquisition =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly holder?: LeaseItem; readonly reason: StructuredReason };

/** A lost lease: the runner interrupts with `LEASE_LOST` and begins emergency cleanup. */
export interface LeaseLoss {
  readonly cause: 'LEASE_LOST';
  readonly health: Extract<LeaseHealth, 'LOST_OWNERSHIP_MISMATCH' | 'LOST_STALE'>;
  readonly reason: StructuredReason;
}

type SessionPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'refused'; readonly owner: LeaseOwner }
  | { readonly kind: 'unresolved'; readonly owner: LeaseOwner }
  | { readonly kind: 'held'; readonly owner: LeaseOwner; readonly state: LeaseHealthState }
  | { readonly kind: 'finalized'; readonly status: LeaseStatus };

type HeldPhase = Extract<SessionPhase, { readonly kind: 'held' }>;

/**
 * The coordination lease of one execution.
 *
 * @example
 * const lease = new LeaseSession({ store, monotonic, wall, journal, heartbeatIntervalMs: 30_000, staleBoundaryMs: 300_000 });
 * const acquisition = await lease.acquire(leaseOwnerOf(execution, manifestSha));
 * if (!acquisition.acquired) return stop('LEASE_ACQUISITION_FAILED');
 * if (lease.publicationAllowed()) publish();
 * const status = await lease.finalize('clean'); // 'released'
 */
export class LeaseSession {
  readonly #deps: LeaseSessionDeps;
  readonly #store: LeaseStorePort;
  readonly #events: LeaseEvent[] = [];
  #phase: SessionPhase = { kind: 'idle' };
  #loss: LeaseLoss | undefined;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(deps: LeaseSessionDeps) {
    this.#deps = deps;
    this.#store = guardLeaseStore(deps.store);
  }

  /**
   * Acquires the lease for `owner`: the execution's first mutation. Throws an Error when this
   * session already tried.
   *
   * @example
   * await lease.acquire(owner); // { acquired: false, holder, reason: { code: 'LEASE_CONFLICT', … } } while another owner holds it
   */
  acquire(owner: LeaseOwner): Promise<LeaseAcquisition> {
    return this.#serialized(() => this.#acquire(owner));
  }

  /**
   * Runs one heartbeat (or, once stale, none) and returns the health after it. A lost lease is
   * not written again. Throws an Error unless the session holds the lease.
   *
   * @example
   * await lease.heartbeatOnce(); // 'CONFIRMED' | 'UNCERTAIN' | 'LOST_OWNERSHIP_MISMATCH' | 'LOST_STALE'
   */
  heartbeatOnce(): Promise<LeaseHealth> {
    return this.#serialized(() => this.#heartbeatOnce());
  }

  /**
   * Whether new publication may start: false unless ownership is confirmed and younger than
   * the stale boundary.
   *
   * @example
   * if (!lease.publicationAllowed()) return stopBeforePublication();
   */
  publicationAllowed(): boolean {
    return this.#phase.kind === 'held' && isPublicationAllowed(this.#phase.state, this.#deps.monotonic.nowNs());
  }

  /**
   * Milliseconds until the next heartbeat is due: the interval, or less near the stale
   * boundary; 0 when the session holds no lease.
   *
   * @example
   * scheduler.schedule(lease.nextHeartbeatDelayMs(), beat);
   */
  nextHeartbeatDelayMs(): number {
    return this.#phase.kind === 'held' ? heartbeatDelayMs(this.#phase.state, this.#deps.monotonic.nowNs()) : 0;
  }

  /**
   * The loss, once ownership mismatch or staleness is established.
   *
   * @example
   * lease.loss()?.cause; // 'LEASE_LOST'
   */
  loss(): LeaseLoss | undefined {
    return this.#loss;
  }

  /**
   * Settles the lease after cleanup and the leak audit: release on a clean closure, recovery on
   * an unclean one. Idempotent: a finalized session returns its status again without writing.
   * Throws an Error before `acquire`.
   *
   * @example
   * await lease.finalize('unclean'); // 'recovery_required'
   */
  finalize(closure: LeaseClosure): Promise<LeaseStatus> {
    return this.#serialized(() => this.#finalize(closure));
  }

  async #acquire(owner: LeaseOwner): Promise<LeaseAcquisition> {
    if (this.#phase.kind !== 'idle') {
      throw new Error(`acquire() in phase ${this.#phase.kind}; expected a session that has not acquired yet`);
    }
    const issuedNs = this.#deps.monotonic.nowNs();
    const at = this.#now();
    const resolution = await resolveAcquisition(this.#store, owner, at, await this.#store.acquire(owner, at));
    if (resolution.kind === 'acquired') {
      const state: LeaseHealthState = {
        health: 'CONFIRMED',
        lease_version: 1,
        last_confirmed_ns: issuedNs,
        last_confirmed_at: at,
      };
      this.#phase = { kind: 'held', owner, state };
      await this.#record({ lease_event: 'ACQUIRED', owner, state, detail: resolution.detail });
      return { acquired: true };
    }
    this.#phase = resolution.kind === 'refused' ? { kind: 'refused', owner } : { kind: 'unresolved', owner };
    const holder = resolution.holder === undefined ? {} : { holder: resolution.holder };
    await this.#record({
      lease_event: 'ACQUISITION_FAILED',
      owner,
      ...(resolution.holder === undefined ? {} : { observed: resolution.holder }),
      detail: resolution.reason.detail,
    });
    return { acquired: false, ...holder, reason: resolution.reason };
  }

  async #heartbeatOnce(): Promise<LeaseHealth> {
    const held = this.#heldPhase('heartbeatOnce()');
    const { owner, state } = held;
    if (isLost(state.health)) {
      return state.health;
    }
    const issuedNs = this.#deps.monotonic.nowNs();
    const beforeWrite = nextLeaseHealth(state, { kind: 'clock', observed_ns: issuedNs });
    if (beforeWrite.health === 'LOST_STALE') {
      const reason = leaseReason(LEASE_REASON_CODES.stale, staleDetail(state, issuedNs));
      return this.#settleBeat(held, beforeWrite, reason, reason.detail, undefined);
    }
    const at = this.#now();
    const outcome = await this.#store.heartbeat(owner, state.lease_version, at);
    const attempt = { owner, expected_version: state.lease_version, issued_ns: issuedNs, at };
    const judged = await judgeHeartbeat(outcome, attempt, { store: this.#store, monotonic: this.#deps.monotonic });
    const next = nextLeaseHealth(state, judged.observation);
    const reason = lossReasonOf(state, next, judged);
    return this.#settleBeat(held, next, reason, reason?.detail ?? judged.detail, judged.observed);
  }

  async #settleBeat(
    previous: HeldPhase,
    next: LeaseHealthState,
    lossReason: StructuredReason | undefined,
    detail: string,
    observed: LeaseItem | undefined,
  ): Promise<LeaseHealth> {
    this.#phase = { kind: 'held', owner: previous.owner, state: next };
    if (lossReason !== undefined) {
      this.#loss = { cause: 'LEASE_LOST', health: next.health as LeaseLoss['health'], reason: lossReason };
    }
    await this.#record({
      lease_event: beatEvent(previous.state.health, next.health),
      owner: previous.owner,
      state: next,
      ...(observed === undefined ? {} : { observed }),
      detail,
    });
    return next.health;
  }

  async #finalize(closure: LeaseClosure): Promise<LeaseStatus> {
    const phase = this.#phase;
    switch (phase.kind) {
      case 'finalized':
        return phase.status;
      case 'idle':
        throw new Error(`finalize(${closure}) before acquire(); expected a session that tried to acquire`);
      case 'refused':
        await this.#record({
          lease_event: 'RELEASED',
          owner: phase.owner,
          detail: 'the acquisition was refused; this owner holds nothing',
        });
        return this.#settleFinal();
      case 'unresolved':
      case 'held':
        await this.#finalizeOwned(phase, closure);
        return this.#settleFinal();
    }
  }

  async #finalizeOwned(
    phase: Extract<SessionPhase, { readonly kind: 'unresolved' | 'held' }>,
    closure: LeaseClosure,
  ): Promise<void> {
    const state = phase.kind === 'held' ? phase.state : undefined;
    const verdict = await finalizeLease({
      store: this.#store,
      owner: phase.owner,
      closure,
      known_version: state?.lease_version ?? 1,
      held: state !== undefined,
      now: () => this.#now(),
    });
    const after =
      state === undefined ? undefined : { ...state, lease_version: verdict.lease_version ?? state.lease_version };
    await this.#record({
      lease_event: verdict.lease_event,
      owner: phase.owner,
      ...(after === undefined ? {} : { state: after }),
      ...(verdict.observed === undefined ? {} : { observed: verdict.observed }),
      detail: verdict.detail,
    });
  }

  #settleFinal(): LeaseStatus {
    const status = deriveFinalLeaseStatus(this.#events);
    this.#phase = { kind: 'finalized', status };
    return status;
  }

  #heldPhase(operation: string): HeldPhase {
    const phase = this.#phase;
    if (phase.kind !== 'held') {
      throw new Error(`${operation} in phase ${phase.kind}; expected a session that holds the lease`);
    }
    return phase;
  }

  async #record(facts: LeaseEventFacts): Promise<void> {
    this.#events.push(facts.lease_event);
    await this.#deps.journal.append('lease_event_recorded', leaseEventBody(facts));
  }

  #now(): UtcMillis {
    return formatUtcMillis(this.#deps.wall.now());
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

// The reason of a loss this beat established; undefined while the lease is still held.
function lossReasonOf(
  previous: LeaseHealthState,
  next: LeaseHealthState,
  judged: HeartbeatJudgement,
): StructuredReason | undefined {
  if (next.health === 'LOST_STALE') {
    return leaseReason(LEASE_REASON_CODES.stale, staleDetail(previous, judged.observation.observed_ns));
  }
  if (judged.observation.kind === 'mismatch') {
    return leaseReason(judged.observation.code, judged.detail);
  }
  return undefined;
}

// The journal event of one heartbeat transition.
function beatEvent(previous: LeaseHealth, next: LeaseHealth): LeaseEvent {
  switch (next) {
    case 'CONFIRMED':
      return previous === 'UNCERTAIN' ? 'RECOVERED' : 'HEARTBEAT_CONFIRMED';
    case 'UNCERTAIN':
      return 'HEARTBEAT_FAILED';
    case 'LOST_OWNERSHIP_MISMATCH':
      return 'LOST_OWNERSHIP_MISMATCH';
    case 'LOST_STALE':
      return 'LOST_STALE';
  }
}

function staleDetail(state: LeaseHealthState, observedNs: bigint): string {
  const elapsedMs = (observedNs - state.last_confirmed_ns) / 1_000_000n;
  return `last confirmed heartbeat at ${state.last_confirmed_at}, ${elapsedMs.toString()} ms ago; expected less than ${(LEASE_STALE_BOUNDARY_NS / 1_000_000n).toString()} ms (stale boundary)`;
}
