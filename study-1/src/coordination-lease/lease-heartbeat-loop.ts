// The heartbeat scheduler that runs beside execution phases P2 to P8 (design §10.2): one
// heartbeat every 30 s (BR-RUA-045), brought forward while uncertain so staleness is
// established at the 300 s boundary, and stopped for good at the first loss. The loss is
// handed to the listener once; the runner's listener interrupts the active trial with
// `LEASE_LOST`, blocks further publication and begins emergency cleanup (AC-RUA-033).
// Beats never overlap: the next one is scheduled only after the previous one settled. The
// runner stops the loop before finalizing the lease; if it finalizes first, the beat that falls
// due finds no held lease (`heartbeatOnce` rejects only then) and the loop ends quietly instead
// of leaving an unhandled rejection behind.

import type { TimerHandle, TimerScheduler } from '../record-contract/primitives.ts';
import type { LeaseLoss, LeaseSession } from './lease-session.ts';

/** Receives the loss of the lease, once. */
export interface LeaseLossListener {
  leaseLost(loss: LeaseLoss): void;
}

export interface LeaseHeartbeatLoopDeps {
  readonly session: LeaseSession;
  readonly scheduler: TimerScheduler;
  readonly listener: LeaseLossListener;
}

/**
 * Runs the session's heartbeats on a timer until stopped or lost.
 *
 * @example
 * const loop = new LeaseHeartbeatLoop({ session: lease, scheduler, listener: runner });
 * loop.start(); // after a successful acquire
 * loop.stop(); // before lease finalization
 */
export class LeaseHeartbeatLoop {
  readonly #deps: LeaseHeartbeatLoopDeps;
  #timer: TimerHandle | undefined;
  #started = false;
  #stopped = false;

  constructor(deps: LeaseHeartbeatLoopDeps) {
    this.#deps = deps;
  }

  /**
   * Schedules the first heartbeat. Throws an Error on a second start.
   *
   * @example
   * loop.start();
   */
  start(): void {
    if (this.#started) {
      throw new Error('LeaseHeartbeatLoop.start() called twice; expected one start per loop');
    }
    this.#started = true;
    this.#scheduleNext();
  }

  /**
   * Cancels the pending heartbeat; a beat already running finishes but schedules nothing.
   *
   * @example
   * loop.stop();
   */
  stop(): void {
    this.#stopped = true;
    this.#timer?.cancel();
    this.#timer = undefined;
  }

  /**
   * Whether the loop still schedules heartbeats.
   *
   * @example
   * loop.isRunning(); // false after a loss or stop()
   */
  isRunning(): boolean {
    return this.#started && !this.#stopped;
  }

  #scheduleNext(): void {
    this.#timer = this.#deps.scheduler.schedule(this.#deps.session.nextHeartbeatDelayMs(), () => {
      this.#timer = undefined;
      void this.#beat();
    });
  }

  async #beat(): Promise<void> {
    const held = await this.#deps.session.heartbeatOnce().then(
      () => true,
      () => false,
    );
    if (!held) {
      this.#stopped = true;
      return;
    }
    const loss = this.#deps.session.loss();
    if (loss !== undefined) {
      this.#stopped = true;
      this.#deps.listener.leaseLost(loss);
      return;
    }
    if (!this.#stopped) {
      this.#scheduleNext();
    }
  }
}
