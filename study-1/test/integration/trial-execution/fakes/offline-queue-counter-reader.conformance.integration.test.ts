// Conformance of OfflineQueueCounterReader to the QueueCounterReader port over SQS
// GetQueueAttributes (https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_GetQueueAttributes.html):
// ApproximateNumberOfMessages counts visible messages, ...NotVisible those in flight, ...Delayed
// is 0 for queues without delivery delay (design §9.5), and an unknown queue is an error.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryFifoQueue } from '../../../support/fifo-queue/in-memory-fifo-queue.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import { OfflineQueueCounterReader } from '../../../support/offline-cloud/offline-queue-counter-reader.ts';

const URL = 'https://sqs.us-east-1.amazonaws.com/012345678901/q.fifo';

describe('OfflineQueueCounterReader conformance', () => {
  it('reads visible and in-flight counts, never delayed ones', async () => {
    const queue = new InMemoryFifoQueue({
      clock: new VirtualTimeScheduler({ wallEpochMs: 0 }),
      ids: new SequentialUuidSource('abcdabcd'),
      visibilityTimeoutMs: 60_000,
    });
    queue.send({ body: 'a', message_group_id: 'g1', message_deduplication_id: 'a' });
    queue.send({ body: 'b', message_group_id: 'g2', message_deduplication_id: 'b' });
    queue.receive();
    const reader = new OfflineQueueCounterReader(new Map([[URL, queue]]));
    assert.deepEqual(await reader.read(URL), { ok: true, value: { visible: 1, in_flight: 1, delayed: 0 } });
  });

  it('fails a scripted read once, and every read of an unknown queue', async () => {
    const queue = new InMemoryFifoQueue({
      clock: new VirtualTimeScheduler({ wallEpochMs: 0 }),
      ids: new SequentialUuidSource('abcdabcd'),
      visibilityTimeoutMs: 60_000,
    });
    const reader = new OfflineQueueCounterReader(new Map([[URL, queue]]));
    reader.failNext(URL, 'RequestThrottled');
    assert.deepEqual(await reader.read(URL), { ok: false, error: { code: 'RequestThrottled' } });
    assert.equal((await reader.read(URL)).ok, true);
    assert.deepEqual(await reader.read(`${URL}x`), {
      ok: false,
      error: { code: 'AWS.SimpleQueueService.NonExistentQueue' },
    });
  });
});
