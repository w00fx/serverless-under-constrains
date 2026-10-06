// Offline stand-in for SQS `GetQueueAttributes` of the three approximate counters (design §5.3
// `QueueCounterReader`, §8.12): the in-memory FIFO queue's visible and in-flight counts, and no
// delayed messages (the study's queues have no delivery delay, design §9.5).
//
// Test hook: `failNext(queueUrl, code)` makes the next read of that queue fail with `code`.

import type { QueueCounterReader } from '../../../src/evidence-collection/queue-observation.ts';
import type { CollectorReadFailure } from '../../../src/evidence-collection/collected-records.ts';
import { err, ok } from '../../../src/record-contract/primitives.ts';
import type { Result } from '../../../src/record-contract/primitives.ts';
import type { QueueCounters } from '../../../src/settlement/settlement-policy.ts';
import type { InMemoryFifoQueue } from '../fifo-queue/in-memory-fifo-queue.ts';

export class OfflineQueueCounterReader implements QueueCounterReader {
  readonly #queues: ReadonlyMap<string, InMemoryFifoQueue>;
  readonly #failures = new Map<string, string>();

  /** `queues` maps each queue URL to the queue it names. */
  constructor(queues: ReadonlyMap<string, InMemoryFifoQueue>) {
    this.#queues = queues;
  }

  read(queueUrl: string): Promise<Result<QueueCounters, CollectorReadFailure>> {
    const failure = this.#failures.get(queueUrl);
    if (failure !== undefined) {
      this.#failures.delete(queueUrl);
      return Promise.resolve(err({ code: failure }));
    }
    const queue = this.#queues.get(queueUrl);
    if (queue === undefined) {
      return Promise.resolve(err({ code: 'AWS.SimpleQueueService.NonExistentQueue' }));
    }
    const counters = queue.approximateCounters();
    return Promise.resolve(ok({ visible: counters.visible, in_flight: counters.in_flight, delayed: 0 }));
  }

  /** The next read of `queueUrl` fails with `code`. */
  failNext(queueUrl: string, code: string): void {
    this.#failures.set(queueUrl, code);
  }
}
