// The application deadline timer of BR-RUA-011 and BR-RUA-023 (design §5.3, RK-03).
//
// Node makes no guarantee about exact timer firing, and libuv schedules from a cached
// millisecond loop time (RF V3), so a 3000 ms timer can fire before 3 s of monotonic time
// have passed. The timer therefore re-reads the monotonic clock on every firing and re-arms
// for the remainder until the elapsed time since the origin reaches the deadline. Only then
// does it call `onDeadline`, so "at least three seconds of source-local monotonic elapsed
// time" holds by construction.

import type { MonotonicClock, TimerHandle, TimerScheduler } from '../record-contract/primitives.ts';

const NS_PER_MS = 1_000_000n;

export interface DeadlineTimerDeps {
  readonly monotonic: MonotonicClock;
  readonly scheduler: TimerScheduler;
}

/**
 * The milliseconds to wait for `remainingNs` nanoseconds: rounded up so a firing on time is
 * never early, and 0 when nothing remains.
 *
 * @example
 * delayMsFor(2_000_001n); // 3
 * delayMsFor(-5n); // 0
 */
export function delayMsFor(remainingNs: bigint): number {
  if (remainingNs <= 0n) {
    return 0;
  }
  return Number((remainingNs + NS_PER_MS - 1n) / NS_PER_MS);
}

/**
 * Fires `onDeadline` once, with the monotonic elapsed time since the origin, as soon as that
 * time is at least the deadline. Never fires synchronously inside `start`.
 *
 * @example
 * const timer = new DeadlineTimer({ monotonic, scheduler });
 * const handle = timer.start(monotonic.nowNs(), 3_000_000_000n, (elapsedNs) => onTimeout(elapsedNs));
 * handle.cancel(); // the transport settled first
 */
export class DeadlineTimer {
  readonly #deps: DeadlineTimerDeps;

  constructor(deps: DeadlineTimerDeps) {
    this.#deps = deps;
  }

  /**
   * Arms the timer. Throws a RangeError for a negative deadline, which no attempt can have.
   *
   * @example
   * timer.start(originNs, 3_000_000_000n, (elapsedNs) => console.log(elapsedNs >= 3_000_000_000n)); // true
   */
  start(originNs: bigint, deadlineNs: bigint, onDeadline: (elapsedNs: bigint) => void): TimerHandle {
    if (deadlineNs < 0n) {
      throw new RangeError(`deadline ${deadlineNs.toString()} ns; expected a nonnegative number of nanoseconds`);
    }
    const { monotonic, scheduler } = this.#deps;
    // Each re-arm replaces `pending`, so `cancel` always reaches the one live firing.
    let pending: TimerHandle;
    const check = (): void => {
      const elapsedNs = monotonic.nowNs() - originNs;
      if (elapsedNs < deadlineNs) {
        pending = scheduler.schedule(delayMsFor(deadlineNs - elapsedNs), check);
        return;
      }
      onDeadline(elapsedNs);
    };
    pending = scheduler.schedule(delayMsFor(deadlineNs - (monotonic.nowNs() - originNs)), check);
    return {
      cancel: (): void => {
        pending.cancel();
      },
    };
  }
}
