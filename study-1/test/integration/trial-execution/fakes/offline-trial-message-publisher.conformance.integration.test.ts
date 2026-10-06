// Conformance of OfflineTrialMessagePublisher to the TrialMessagePublisher port over SQS
// SendMessage (https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessage.html):
// a sent message is on the queue with its group and deduplication ids and the send returns its
// id, sequence number and body MD5; an unknown queue is rejected; a scripted rejection sends
// nothing, a scripted ambiguous send still reaches the queue.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { InMemoryFifoQueue } from '../../../support/fifo-queue/in-memory-fifo-queue.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import { OfflineMessageLog } from '../../../support/offline-cloud/offline-message-log.ts';
import { OfflineTrialMessagePublisher } from '../../../support/offline-cloud/offline-trial-message-publisher.ts';

const URL = 'https://sqs.us-east-1.amazonaws.com/012345678901/q.fifo';
const send = { queue_url: URL, body: '{"m":1}', message_group_id: 't', message_deduplication_id: 't' } as const;

function fixture(): { readonly publisher: OfflineTrialMessagePublisher; readonly queue: InMemoryFifoQueue } {
  const clock = new VirtualTimeScheduler({ wallEpochMs: 0 });
  const queue = new InMemoryFifoQueue({
    clock,
    ids: new SequentialUuidSource('abcdabcd'),
    visibilityTimeoutMs: 60_000,
  });
  return { publisher: new OfflineTrialMessagePublisher(new Map([[URL, queue]]), new OfflineMessageLog(clock)), queue };
}

describe('OfflineTrialMessagePublisher conformance', () => {
  it('sends onto the queue and returns what SQS returns', async () => {
    const { publisher, queue } = fixture();
    const outcome = await publisher.publish(send);
    assert.equal(outcome.kind, 'sent');
    const [stored] = queue.messages();
    assert.equal(outcome.message_id, stored?.message_id);
    assert.equal(outcome.md5_of_message_body, createHash('md5').update(send.body).digest('hex'));
    assert.equal(stored?.body, send.body);
    assert.deepEqual(publisher.sends(), [send]);
  });

  it('rejects a send to an unknown queue', async () => {
    const { publisher } = fixture();
    assert.deepEqual(await publisher.publish({ ...send, queue_url: `${URL}x` }), {
      kind: 'rejected',
      code: 'AWS.SimpleQueueService.NonExistentQueue',
    });
  });

  it('a scripted rejection sends nothing and an ambiguous send reaches the queue, once each', async () => {
    const { publisher, queue } = fixture();
    publisher.failNext({ kind: 'rejected', code: 'AccessDenied' });
    assert.equal((await publisher.publish(send)).kind, 'rejected');
    assert.equal(queue.messages().length, 0);
    publisher.failNext({ kind: 'ambiguous', code: 'RequestTimeout' });
    assert.equal((await publisher.publish(send)).kind, 'ambiguous');
    assert.equal(queue.messages().length, 1);
    assert.equal((await publisher.publish({ ...send, message_deduplication_id: 'u' })).kind, 'sent');
  });

  it('tamperNextBody rewrites the next body only', async () => {
    const { publisher, queue } = fixture();
    publisher.tamperNextBody((body) => body.replace('1', '2'));
    await publisher.publish(send);
    await publisher.publish({ ...send, message_deduplication_id: 'u' });
    assert.deepEqual(
      queue.messages().map((message) => message.body),
      ['{"m":2}', '{"m":1}'],
    );
  });
});
