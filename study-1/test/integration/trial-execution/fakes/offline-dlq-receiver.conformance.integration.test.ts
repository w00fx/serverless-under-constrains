// Conformance of OfflineDlqReceiver to the DlqReceiver port over SQS ReceiveMessage with a zero
// visibility timeout (https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html):
// at most 10 messages per receive, none hidden or deleted by it, each with MD5OfBody and the
// requested system attributes; an unknown queue or a scripted failure is an error.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryFifoQueue } from '../../../support/fifo-queue/in-memory-fifo-queue.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import { OfflineDlqReceiver, RECEIVE_BATCH_LIMIT } from '../../../support/offline-cloud/offline-dlq-receiver.ts';
import { OfflineMessageLog } from '../../../support/offline-cloud/offline-message-log.ts';

const URL = 'https://sqs.us-east-1.amazonaws.com/012345678901/dlq.fifo';

function fixture(): {
  readonly receiver: OfflineDlqReceiver;
  readonly queue: InMemoryFifoQueue;
  readonly log: OfflineMessageLog;
} {
  const clock = new VirtualTimeScheduler({ wallEpochMs: 7_000 });
  const queue = new InMemoryFifoQueue({
    clock,
    ids: new SequentialUuidSource('abcdabcd'),
    visibilityTimeoutMs: 60_000,
  });
  const log = new OfflineMessageLog(clock);
  return { receiver: new OfflineDlqReceiver(new Map([[URL, queue]]), log), queue, log };
}

describe('OfflineDlqReceiver conformance', () => {
  it('returns at most 10 head messages, again on every receive, with their attributes', async () => {
    const { receiver, queue, log } = fixture();
    for (let index = 0; index < RECEIVE_BATCH_LIMIT + 2; index += 1) {
      log.send(queue, {
        body: `m${String(index)}`,
        message_group_id: `g${String(index)}`,
        message_deduplication_id: `d${String(index)}`,
      });
    }
    const first = await receiver.receiveBatch(URL);
    const again = await receiver.receiveBatch(URL);
    assert.ok(first.ok && again.ok);
    assert.equal(first.value.length, RECEIVE_BATCH_LIMIT);
    assert.deepEqual(again.value, first.value);
    const head = first.value[0];
    const logged = log.find(String(head?.MessageId));
    assert.equal(head?.MD5OfBody, logged?.md5_of_body);
    assert.deepEqual(head?.Attributes, {
      ApproximateReceiveCount: '1',
      ApproximateFirstReceiveTimestamp: '7000',
      SentTimestamp: '7000',
      MessageGroupId: 'g0',
      MessageDeduplicationId: 'd0',
      SequenceNumber: logged?.sequence_number,
    });
    assert.equal(queue.approximateCounters().visible, RECEIVE_BATCH_LIMIT + 2);
  });

  it('returns a message sent around the log without attributes, as a malformed one', async () => {
    const { receiver, queue } = fixture();
    queue.send({ body: 'raw', message_group_id: 'g', message_deduplication_id: 'd' });
    const received = await receiver.receiveBatch(URL);
    assert.deepEqual(received.ok ? received.value.map((message) => Object.keys(message)) : [], [['MessageId', 'Body']]);
  });

  it('fails a scripted receive once, and every receive of an unknown queue', async () => {
    const { receiver } = fixture();
    receiver.failNext('OverLimit');
    assert.deepEqual(await receiver.receiveBatch(URL), { ok: false, error: { code: 'OverLimit' } });
    assert.deepEqual(await receiver.receiveBatch(URL), { ok: true, value: [] });
    assert.deepEqual(await receiver.receiveBatch(`${URL}x`), {
      ok: false,
      error: { code: 'AWS.SimpleQueueService.NonExistentQueue' },
    });
  });
});
