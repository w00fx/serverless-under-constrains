// A sleeper that moves virtual time itself: `sleep(ms)` advances the shared
// `VirtualTimeScheduler` by `ms`. Cleanup waits in long polling loops (stack deletion, the 120 s
// audit interval); with this sleeper a test runs them to completion without driving time from
// outside. Faults: `wakeEarlyBy(ms)` makes the next sleep end early (the RK-03 early timer), and
// `stall()` makes every later sleep end without time passing.

import type { Sleeper } from '../../../src/record-contract/primitives.ts';
import type { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';

/**
 * Sleeps by advancing virtual time, and records every requested duration.
 *
 * @example
 * const sleeper = new SelfAdvancingSleeper(time);
 * await sleeper.sleep(120_000); // time.nowNs() moved by 120 s
 * sleeper.requests(); // [120000]
 */
export class SelfAdvancingSleeper implements Sleeper {
  readonly #time: VirtualTimeScheduler;
  readonly #requests: number[] = [];
  #earlyByMs = 0;
  #stalled = false;

  constructor(time: VirtualTimeScheduler) {
    this.#time = time;
  }

  /** The next sleep wakes `ms` early (never earlier than now); one-shot. */
  wakeEarlyBy(ms: number): void {
    this.#earlyByMs = ms;
  }

  /** Every later sleep returns without advancing time. */
  stall(): void {
    this.#stalled = true;
  }

  /** The durations requested so far, in call order. */
  requests(): readonly number[] {
    return [...this.#requests];
  }

  async sleep(ms: number): Promise<void> {
    this.#requests.push(ms);
    const advance = this.#stalled ? 0 : Math.max(0, ms - this.#earlyByMs);
    this.#earlyByMs = 0;
    await this.#time.advanceBy(advance);
  }
}
