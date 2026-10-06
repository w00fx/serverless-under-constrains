// The runner's side of a lease loss, as a recording stand-in (design §10.2): on `leaseLost` the
// runner interrupts the active trial with `LEASE_LOST`, blocks publication and begins
// emergency cleanup (AC-RUA-033). This listener records each loss with the virtual instant it
// arrived, so a test can prove that the interruption and the emergency-cleanup request happened,
// once, and when.

import type { LeaseLossListener } from '../../../src/coordination-lease/lease-heartbeat-loop.ts';
import type { LeaseLoss } from '../../../src/coordination-lease/lease-session.ts';
import type { MonotonicClock } from '../../../src/record-contract/primitives.ts';

export interface RecordedLeaseLoss {
  readonly loss: LeaseLoss;
  /** Monotonic nanoseconds when the loss arrived. */
  readonly at_ns: bigint;
}

/**
 * Records every lease loss and treats it as the interruption and emergency-cleanup request.
 *
 * @example
 * const runner = new RecordingLeaseLossListener(time);
 * new LeaseHeartbeatLoop({ session, scheduler: time, listener: runner }).start();
 * runner.emergencyCleanupRequested(); // true after a loss
 */
export class RecordingLeaseLossListener implements LeaseLossListener {
  readonly #clock: MonotonicClock;
  readonly #losses: RecordedLeaseLoss[] = [];

  constructor(clock: MonotonicClock) {
    this.#clock = clock;
  }

  leaseLost(loss: LeaseLoss): void {
    this.#losses.push({ loss, at_ns: this.#clock.nowNs() });
  }

  /** Every loss received, in order. */
  losses(): readonly RecordedLeaseLoss[] {
    return [...this.#losses];
  }

  /** The runner interrupts active work with the cause of the first loss. */
  interruptionCause(): LeaseLoss['cause'] | undefined {
    return this.#losses[0]?.loss.cause;
  }

  /** The runner begins emergency cleanup on the first loss. */
  emergencyCleanupRequested(): boolean {
    return this.#losses.length > 0;
  }
}
