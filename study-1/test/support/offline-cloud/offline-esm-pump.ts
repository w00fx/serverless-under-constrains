// Offline stand-in for the Lambda SQS event source mapping's poller (design §12.2): on every tick
// of the offline cloud's clock, while enabled, it starts one poll of the FakeSqsEsmDriver unless a
// poll is still running, so the FIFO source is consumed one message at a time, in order, with
// batch size 1. A poll is never awaited by the tick: the consumer it invokes waits on virtual
// timers (the provider deadline), which only advance after the tick returns.
//
// Test hooks: `pause()` and `resume()` (an ESM that is disabled leaves messages visible), and
// `whenIdle()` to wait for the poll in flight.

import type { WallClock } from '../../../src/record-contract/primitives.ts';
import type { FakeSqsEsmDriver, PollResult } from '../fifo-queue/fake-sqs-esm-driver.ts';
import type { OfflineMessageLog } from './offline-message-log.ts';

export class OfflineEsmPump {
  readonly #driver: FakeSqsEsmDriver;
  readonly #log: OfflineMessageLog;
  readonly #clock: WallClock;
  readonly #results: PollResult[] = [];
  #inFlight: Promise<void> | undefined;
  #paused = false;

  constructor(driver: FakeSqsEsmDriver, log: OfflineMessageLog, clock: WallClock) {
    this.#driver = driver;
    this.#log = log;
    this.#clock = clock;
  }

  /** Starts a poll unless paused or one is still running. */
  tick(): void {
    if (this.#paused || this.#inFlight !== undefined) {
      return;
    }
    const startedAt = this.#clock.now().getTime();
    this.#inFlight = this.#driver.pollOnce().then(
      (result) => {
        this.#record(result, startedAt);
      },
      (error: unknown) => {
        this.#record({ kind: 'failed', message_id: '', receive_count: 0, error }, startedAt);
      },
    );
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  /** Every poll that received something, in order. */
  results(): readonly PollResult[] {
    return [...this.#results];
  }

  /** Resolves once the poll in flight, if any, has finished. */
  async whenIdle(): Promise<void> {
    await this.#inFlight;
  }

  #record(result: PollResult, startedAt: number): void {
    this.#inFlight = undefined;
    if (result.kind === 'empty') {
      return;
    }
    this.#results.push(result);
    this.#log.noteReceived(result.message_id, startedAt);
  }
}
