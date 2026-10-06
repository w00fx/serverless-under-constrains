// One virtual time base behind WallClock, MonotonicClock, TimerScheduler and Sleeper
// (design §12.2). Time moves only when a test advances it, so timer races are deterministic.
//
// Fault injection:
// - fireEarlyBy(ns): the next scheduled timer fires that many nanoseconds before its delay
//   elapses. Node makes no guarantee about exact timer firing (RF V3, Node timers docs), so a
//   deadline timer must re-check monotonic elapsed time (RK-03).
// - skewWall(ms): shifts the wall clock against the monotonic clock, for the cross-source
//   clock assumption CA-1.

import type {
  MonotonicClock,
  Sleeper,
  TimerHandle,
  TimerScheduler,
  WallClock,
} from '../../../src/record-contract/primitives.ts';

const NS_PER_MS = 1_000_000n;
const MAX_FIRINGS_PER_ADVANCE = 100_000;

interface PendingTimer {
  readonly dueNs: bigint;
  readonly order: number;
  readonly callback: () => void;
}

export interface VirtualTimeOptions {
  /** Wall-clock instant at virtual time zero, as epoch milliseconds. */
  readonly wallEpochMs: number;
  /** Monotonic reading at virtual time zero (an arbitrary, source-local origin). */
  readonly monotonicOriginNs?: bigint;
}

/**
 * Wall clock, monotonic clock, timers and sleep on one virtual time base that moves only when
 * a test advances it.
 *
 * @example
 * const time = new VirtualTimeScheduler({ wallEpochMs: Date.parse('2026-10-05T12:00:00.000Z') });
 * const fired: string[] = [];
 * time.schedule(3000, () => fired.push('deadline'));
 * await time.advanceBy(3000); // fired = ['deadline'], time.nowNs() = 3_000_000_000n
 */
export class VirtualTimeScheduler implements WallClock, MonotonicClock, TimerScheduler, Sleeper {
  readonly #wallEpochMs: number;
  readonly #monotonicOriginNs: bigint;
  readonly #timers = new Map<number, PendingTimer>();
  #elapsedNs = 0n;
  #wallSkewMs = 0;
  #nextOrder = 0;
  #earlyByNs = 0n;

  constructor(options: VirtualTimeOptions) {
    this.#wallEpochMs = options.wallEpochMs;
    this.#monotonicOriginNs = options.monotonicOriginNs ?? 0n;
  }

  /** Wall-clock reading: the epoch plus elapsed virtual time plus any skew. */
  now(): Date {
    return new Date(this.#wallEpochMs + Number(this.#elapsedNs / NS_PER_MS) + this.#wallSkewMs);
  }

  /** Monotonic reading in nanoseconds; never moved by `skewWall`. */
  nowNs(): bigint {
    return this.#monotonicOriginNs + this.#elapsedNs;
  }

  /** Schedules `callback` after `delayMs` virtual milliseconds; the handle cancels it. */
  schedule(delayMs: number, callback: () => void): TimerHandle {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError(`timer delay ${String(delayMs)} ms; expected a finite nonnegative number of milliseconds`);
    }
    const order = this.#nextOrder;
    this.#nextOrder += 1;
    const requestedNs = this.#elapsedNs + BigInt(Math.round(delayMs * 1_000_000));
    const dueNs = requestedNs - this.#earlyByNs < this.#elapsedNs ? this.#elapsedNs : requestedNs - this.#earlyByNs;
    this.#earlyByNs = 0n;
    this.#timers.set(order, { dueNs, order, callback });
    return { cancel: () => this.#timers.delete(order) };
  }

  /** Resolves once virtual time has advanced by `ms`. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.schedule(ms, resolve);
    });
  }

  /** The next timer scheduled after this call fires `ns` nanoseconds early (one-shot). */
  fireEarlyBy(ns: bigint): void {
    if (ns < 0n) {
      throw new RangeError(`early firing ${ns.toString()} ns; expected a nonnegative offset`);
    }
    this.#earlyByNs = ns;
  }

  /** Moves the wall clock by `ms` without moving monotonic time. */
  skewWall(ms: number): void {
    this.#wallSkewMs += ms;
  }

  /** Timers scheduled and neither fired nor cancelled. */
  pendingTimerCount(): number {
    return this.#timers.size;
  }

  /**
   * Advances virtual time by `ms`, firing due timers in due-time order (ties in scheduling
   * order) and letting promise continuations settle after each firing. Monotonic time never
   * moves backwards, so a negative or non-finite `ms` is refused.
   */
  async advanceBy(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`advance of ${String(ms)} ms; expected a finite nonnegative number of milliseconds`);
    }
    const targetNs = this.#elapsedNs + BigInt(Math.round(ms * 1_000_000));
    await this.#runTimersUntil(targetNs);
    this.#elapsedNs = targetNs;
    await settle();
  }

  /** Fires timers until none is pending, including timers scheduled while firing. */
  async advanceUntilIdle(): Promise<void> {
    await this.#runTimersUntil(undefined);
  }

  async #runTimersUntil(limitNs: bigint | undefined): Promise<void> {
    for (let firings = 0; firings < MAX_FIRINGS_PER_ADVANCE; firings += 1) {
      const next = this.#earliestTimer();
      if (next === undefined || (limitNs !== undefined && next.dueNs > limitNs)) {
        return;
      }
      this.#timers.delete(next.order);
      this.#elapsedNs = next.dueNs > this.#elapsedNs ? next.dueNs : this.#elapsedNs;
      next.callback();
      await settle();
    }
    throw new Error(
      `more than ${String(MAX_FIRINGS_PER_ADVANCE)} timer firings in one advance; expected the timers to go idle`,
    );
  }

  #earliestTimer(): PendingTimer | undefined {
    let earliest: PendingTimer | undefined;
    for (const timer of this.#timers.values()) {
      if (earliest === undefined || timer.dueNs < earliest.dueNs) {
        earliest = timer;
      }
    }
    return earliest;
  }
}

// setImmediate runs after every queued microtask, so awaiting it lets promise chains that a
// timer callback resolved run to their next await.
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
