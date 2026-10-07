// The coordination lease as the runner sees it, scripted: acquisition succeeds or is refused, a
// test loses the lease, or leaves its ownership unconfirmed (publication paused while the heartbeat
// recovers, design §10.3), at the moment it chooses, and finalization answers the status the test
// asked for. The real `SessionExecutionLease` over `FakeLeaseStore` is used where the lease's own
// writes are the evidence (AC-RUA-008); this fake isolates the runner's reactions to the lease.

import type { LeaseClosure } from '../../../../src/coordination-lease/lease-finalization.ts';
import type { LeaseLoss } from '../../../../src/coordination-lease/lease-session.ts';
import type { StructuredReason } from '../../../../src/record-contract/primitives.ts';
import type { LeaseStatus } from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import type { ExecutionLease } from '../../../../src/execution-lifecycle/execution-ports.ts';

/** What the scripted lease answers. */
export interface ScriptedLeaseOptions {
  /** Acquisition is refused with this reason. */
  readonly refusal?: StructuredReason;
  /** Finalization answers this status whatever the closure (released after clean, else recovery_required). */
  readonly finalStatus?: LeaseStatus;
}

/**
 * A lease that records every call and loses ownership on request.
 *
 * @example
 * const lease = new ScriptedExecutionLease();
 * lease.startHeartbeats((loss) => gate.interrupt(loss));
 * lease.lose(); // the listener is told once
 */
export class ScriptedExecutionLease implements ExecutionLease {
  readonly #options: ScriptedLeaseOptions;
  readonly #calls: string[] = [];
  #onLoss: ((loss: LeaseLoss) => void) | undefined;
  #allowed = true;

  constructor(options: ScriptedLeaseOptions = {}) {
    this.#options = options;
  }

  /** Every call, in order: `acquire`, `startHeartbeats`, `stopHeartbeats`, `finalize:<closure>`. */
  calls(): readonly string[] {
    return [...this.#calls];
  }

  /** The heartbeat loses ownership: publication stops and the listener, if started, is told. */
  lose(): void {
    this.#allowed = false;
    this.#onLoss?.({
      cause: 'LEASE_LOST',
      health: 'LOST_OWNERSHIP_MISMATCH',
      reason: { code: 'LEASE_OWNERSHIP_MISMATCH', subject: 'BR-RUA-045', detail: 'a foreign owner holds the lease' },
    });
  }

  /** The heartbeat cannot confirm ownership yet: publication pauses, and no loss is reported. */
  suspend(): void {
    this.#allowed = false;
  }

  acquire(): Promise<{ readonly acquired: true } | { readonly acquired: false; readonly reason: StructuredReason }> {
    this.#calls.push('acquire');
    const { refusal } = this.#options;
    return Promise.resolve(refusal === undefined ? { acquired: true } : { acquired: false, reason: refusal });
  }

  publicationAllowed(): boolean {
    return this.#allowed;
  }

  startHeartbeats(onLoss: (loss: LeaseLoss) => void): void {
    this.#calls.push('startHeartbeats');
    this.#onLoss = onLoss;
  }

  stopHeartbeats(): void {
    this.#calls.push('stopHeartbeats');
    this.#onLoss = undefined;
  }

  finalize(closure: LeaseClosure): Promise<LeaseStatus> {
    this.#calls.push(`finalize:${closure}`);
    const status = this.#options.finalStatus ?? (closure === 'clean' ? 'released' : 'recovery_required');
    return Promise.resolve(status);
  }
}
