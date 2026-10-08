// A named fake of the collector's `QueueCounterReader` port (design §5.3, §12.2): each queue URL
// holds its current counters, and a scripted failure answers the next read of that URL instead.
// An unknown URL fails with `QueueDoesNotExist`, as SQS does.

import type { Result } from '../../../src/record-contract/primitives.ts';
import type { QueueCounters } from '../../../src/record-contract/records/group-b/shared-shapes.ts';
import type { CollectorReadFailure } from '../../../src/evidence-collection/collected-records.ts';
import type { QueueCounterReader } from '../../../src/evidence-collection/queue-observation.ts';

/**
 * Queue counters by URL, with one-shot failures.
 *
 * @example
 * const queues = new ScriptedQueueCounterReader();
 * queues.setCounters(sourceUrl, { visible: 0, in_flight: 1, delayed: 0 });
 * queues.scriptFailure(sourceUrl, 'ThrottlingException');
 */
export class ScriptedQueueCounterReader implements QueueCounterReader {
  readonly #counters = new Map<string, QueueCounters>();
  readonly #failures = new Map<string, string[]>();
  readonly #reads: string[] = [];

  setCounters(queueUrl: string, counters: QueueCounters): void {
    this.#counters.set(queueUrl, counters);
  }

  /** The next read of `queueUrl` fails with `code`; failures queue in order. */
  scriptFailure(queueUrl: string, code: string): void {
    this.#failures.set(queueUrl, [...(this.#failures.get(queueUrl) ?? []), code]);
  }

  /** Every URL read, in order. */
  reads(): readonly string[] {
    return [...this.#reads];
  }

  read(queueUrl: string): Promise<Result<QueueCounters, CollectorReadFailure>> {
    this.#reads.push(queueUrl);
    const code = this.#failures.get(queueUrl)?.shift();
    if (code !== undefined) {
      return Promise.resolve({ ok: false, error: { code } });
    }
    const counters = this.#counters.get(queueUrl);
    return Promise.resolve(
      counters === undefined
        ? { ok: false, error: { code: 'QueueDoesNotExist' } }
        : { ok: true, value: { ...counters } },
    );
  }
}
