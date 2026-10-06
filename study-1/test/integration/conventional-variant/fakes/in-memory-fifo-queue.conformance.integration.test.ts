// Conformance of InMemoryFifoQueue to the SQS FIFO facts it emulates (design/aws-semantics.md §3,
// cited per case). The conventional consumer's tests rely on these behaviors, so each is pinned
// here against the documented source, not against the consumer.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEDUPLICATION_INTERVAL_MS, InMemoryFifoQueue } from '../../../support/fifo-queue/in-memory-fifo-queue.ts';
import type { FifoQueueOptions } from '../../../support/fifo-queue/in-memory-fifo-queue.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';

const VISIBILITY_MS = 60_000;

interface QueuePair {
  readonly time: VirtualTimeScheduler;
  readonly source: InMemoryFifoQueue;
  readonly dlq: InMemoryFifoQueue;
}

function queues(overrides: Partial<FifoQueueOptions> = {}): QueuePair {
  const time = new VirtualTimeScheduler({ wallEpochMs: 0 });
  const ids = new SequentialUuidSource('99999999');
  const dlq = new InMemoryFifoQueue({ clock: time, ids, visibilityTimeoutMs: VISIBILITY_MS });
  const source = new InMemoryFifoQueue({
    clock: time,
    ids,
    visibilityTimeoutMs: VISIBILITY_MS,
    redrive: { maxReceiveCount: 2, deadLetterQueue: dlq },
    ...overrides,
  });
  return { time, source, dlq };
}

function send(queue: InMemoryFifoQueue, group: string, dedup: string, body = `body-${dedup}`): string {
  return queue.send({ body, message_group_id: group, message_deduplication_id: dedup }).message_id;
}

describe('InMemoryFifoQueue construction', () => {
  it('refuses a negative or fractional visibility timeout and a maxReceiveCount below 1', () => {
    const time = new VirtualTimeScheduler({ wallEpochMs: 0 });
    const ids = new SequentialUuidSource('99999999');
    assert.throws(() => new InMemoryFifoQueue({ clock: time, ids, visibilityTimeoutMs: -1 }), {
      name: 'RangeError',
      message: 'visibilityTimeoutMs -1; expected a nonnegative safe integer',
    });
    assert.throws(() => new InMemoryFifoQueue({ clock: time, ids, visibilityTimeoutMs: 1.5 }), RangeError);
    const dlq = new InMemoryFifoQueue({ clock: time, ids, visibilityTimeoutMs: 0 });
    assert.throws(
      () =>
        new InMemoryFifoQueue({
          clock: time,
          ids,
          visibilityTimeoutMs: 0,
          redrive: { maxReceiveCount: 0, deadLetterQueue: dlq },
        }),
      { name: 'RangeError', message: 'maxReceiveCount 0; expected a positive safe integer' },
    );
  });
});

describe('InMemoryFifoQueue delivery (aws-semantics §3)', () => {
  it('delivers a group one message at a time: nothing else of the group while its head is in flight', async () => {
    const { time, source } = queues();
    const first = send(source, 'g', 'd-1');
    const second = send(source, 'g', 'd-2');
    const other = send(source, 'h', 'd-3');
    const received = source.receive();
    assert.equal(received?.message_id, first);
    assert.equal(source.receive()?.message_id, other, 'another group is still delivered');
    assert.equal(source.receive(), undefined, 'the second message of g waits for its head');
    assert.equal(source.deleteMessage(received.receipt_handle), true);
    assert.equal(source.receive()?.message_id, second);
    await time.advanceBy(VISIBILITY_MS);
    const returned = source.receive();
    assert.deepEqual(
      [returned?.message_id, returned?.approximate_receive_count],
      [second, 2],
      'an undeleted message returns after the visibility timeout, ahead of later groups',
    );
    assert.equal(source.receive()?.message_id, other);
  });

  it('counts receives, keeps the first receive time, and issues a fresh receipt handle per receive', async () => {
    const { time, source } = queues();
    send(source, 'g', 'd-1');
    await time.advanceBy(5);
    const first = source.receive();
    assert.equal(source.receive(), undefined, 'invisible until the visibility timeout expires');
    await time.advanceBy(VISIBILITY_MS - 1);
    assert.equal(source.receive(), undefined);
    await time.advanceBy(1);
    const second = source.receive();
    assert.deepEqual(
      [
        first?.approximate_receive_count,
        second?.approximate_receive_count,
        first?.sent_at_ms,
        second?.first_received_at_ms,
      ],
      [1, 2, 0, 5],
    );
    assert.notEqual(first?.receipt_handle, second?.receipt_handle);
    assert.equal(source.deleteMessage(first?.receipt_handle ?? ''), false, 'a stale receipt handle deletes nothing');
    assert.equal(source.deleteMessage(second?.receipt_handle ?? ''), true);
    assert.deepEqual(source.messages(), []);
  });

  it('moves a message to the DLQ on the receive that would exceed maxReceiveCount, keeping its id and count', async () => {
    const { time, source, dlq } = queues();
    const id = send(source, 'g', 'd-1');
    source.receive();
    await time.advanceBy(VISIBILITY_MS);
    source.receive();
    assert.deepEqual(dlq.messages(), [], 'two receives are both deliveries');
    await time.advanceBy(VISIBILITY_MS);
    assert.equal(source.receive(), undefined, 'the third receive moves it instead of delivering it');
    assert.deepEqual(source.messages(), []);
    assert.deepEqual(dlq.messages(), [
      { message_id: id, body: 'body-d-1', message_group_id: 'g', receive_count: 2, in_flight: false },
    ]);
    assert.equal(dlq.receive()?.message_id, id, 'the original message ID is retained');
  });

  it('delivers the next group after redriving a head in the same receive', async () => {
    const { time, source, dlq } = queues();
    const redriven = send(source, 'g', 'd-1');
    source.receive();
    await time.advanceBy(VISIBILITY_MS);
    source.receive();
    await time.advanceBy(VISIBILITY_MS);
    const next = send(source, 'h', 'd-2');
    assert.equal(source.receive()?.message_id, next);
    assert.deepEqual(
      dlq.messages().map((message) => message.message_id),
      [redriven],
    );
  });

  it('never moves a message without a redrive policy', async () => {
    const { time, dlq } = queues();
    send(dlq, 'g', 'd-1');
    for (let receive = 1; receive <= 4; receive += 1) {
      assert.equal(dlq.receive()?.approximate_receive_count, receive);
      await time.advanceBy(VISIBILITY_MS);
    }
    assert.equal(dlq.messages().length, 1);
  });
});

describe('InMemoryFifoQueue deduplication (SQS FIFO exactly-once processing; UNVERIFIED in §3)', () => {
  it('accepts a duplicate within 5 minutes without enqueueing it, answering with the original id', async () => {
    const { time, source } = queues();
    const id = send(source, 'g', 'd-1');
    await time.advanceBy(DEDUPLICATION_INTERVAL_MS - 1);
    assert.deepEqual(source.send({ body: 'x', message_group_id: 'g', message_deduplication_id: 'd-1' }), {
      message_id: id,
      deduplicated: true,
    });
    assert.equal(source.messages().length, 1);
    await time.advanceBy(1);
    const again = source.send({ body: 'x', message_group_id: 'g', message_deduplication_id: 'd-1' });
    assert.equal(again.deduplicated, false);
    assert.notEqual(again.message_id, id);
    assert.equal(source.messages().length, 2);
  });
});

describe('InMemoryFifoQueue approximate counters (aws-semantics §3, RK-14)', () => {
  it('reports the counters as they stood counterLagMs ago, and zeros before any snapshot that old', async () => {
    const { time, source } = queues({ counterLagMs: 60_000 });
    send(source, 'g', 'd-1');
    assert.deepEqual(source.approximateCounters(), { visible: 0, in_flight: 0 }, 'no snapshot is a minute old yet');
    await time.advanceBy(60_000);
    assert.deepEqual(source.approximateCounters(), { visible: 1, in_flight: 0 });
    source.receive();
    assert.deepEqual(source.approximateCounters(), { visible: 1, in_flight: 0 }, 'the receive is not visible yet');
    await time.advanceBy(60_000);
    assert.deepEqual(source.approximateCounters(), { visible: 0, in_flight: 1 });
  });

  it('reports the true state without a lag', () => {
    const { source } = queues();
    send(source, 'g', 'd-1');
    send(source, 'h', 'd-2');
    source.receive();
    assert.deepEqual(source.approximateCounters(), { visible: 1, in_flight: 1 });
  });
});
