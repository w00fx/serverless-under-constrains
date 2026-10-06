// Conformance of OfflineEsmPump to the Lambda SQS event source mapping poller it stands in for
// (https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html): with batch size 1 on a FIFO queue
// one poll is in flight at a time, a disabled mapping leaves messages visible, and every receive is
// noted at the instant its poll started.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeSqsEsmDriver } from '../../../support/fifo-queue/fake-sqs-esm-driver.ts';
import { InMemoryFifoQueue } from '../../../support/fifo-queue/in-memory-fifo-queue.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import { OfflineEsmPump } from '../../../support/offline-cloud/offline-esm-pump.ts';
import { OfflineMessageLog } from '../../../support/offline-cloud/offline-message-log.ts';

/** An SQS function that completes only when released, so a poll can be held in flight. */
class GatedSqsFunction {
  readonly #releases: (() => void)[] = [];
  invocations = 0;

  invoke = (): Promise<void> => {
    this.invocations += 1;
    return new Promise((resolve) => {
      this.#releases.push(resolve);
    });
  };

  releaseAll(): void {
    for (const release of this.#releases.splice(0)) {
      release();
    }
  }
}

function fixture(): {
  readonly pump: OfflineEsmPump;
  readonly queue: InMemoryFifoQueue;
  readonly log: OfflineMessageLog;
  readonly fn: GatedSqsFunction;
} {
  const clock = new VirtualTimeScheduler({ wallEpochMs: 3_000 });
  const queue = new InMemoryFifoQueue({
    clock,
    ids: new SequentialUuidSource('abcdabcd'),
    visibilityTimeoutMs: 60_000,
  });
  const fn = new GatedSqsFunction();
  const driver = new FakeSqsEsmDriver({
    queue,
    invoke: fn.invoke,
    event_source_arn: 'arn:aws:sqs:us-east-1:012345678901:q.fifo',
  });
  const log = new OfflineMessageLog(clock);
  return { pump: new OfflineEsmPump(driver, log, clock), queue, log, fn };
}

describe('OfflineEsmPump conformance', () => {
  it('keeps one poll in flight and records its receive at the poll start', async () => {
    const { pump, queue, log, fn } = fixture();
    const first = log.send(queue, { body: 'a', message_group_id: 'g1', message_deduplication_id: 'a' });
    log.send(queue, { body: 'b', message_group_id: 'g2', message_deduplication_id: 'b' });
    pump.tick();
    pump.tick();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(fn.invocations, 1);
    fn.releaseAll();
    await pump.whenIdle();
    assert.deepEqual(
      pump.results().map((result) => result.kind),
      ['completed'],
    );
    assert.equal(log.firstReceivedAt(first.message_id), 3_000);
  });

  it('a paused pump polls nothing; an empty poll records no result', async () => {
    const { pump, queue, log, fn } = fixture();
    pump.tick();
    await pump.whenIdle();
    assert.deepEqual(pump.results(), []);
    log.send(queue, { body: 'a', message_group_id: 'g1', message_deduplication_id: 'a' });
    pump.pause();
    pump.tick();
    await pump.whenIdle();
    assert.equal(fn.invocations, 0);
    assert.equal(queue.approximateCounters().visible, 1);
    pump.resume();
    pump.tick();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(fn.invocations, 1);
  });
});
