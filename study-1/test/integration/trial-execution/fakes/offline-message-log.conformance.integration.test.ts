// Conformance of OfflineMessageLog to what SQS reports about a FIFO send (SendMessage API reference,
// https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessage.html):
// MD5OfMessageBody is the MD5 of the body, SequenceNumber is a 128-bit decimal that increases with
// every accepted message, and a send deduplicated within the window returns the first message.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { InMemoryFifoQueue } from '../../../support/fifo-queue/in-memory-fifo-queue.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import { OfflineMessageLog } from '../../../support/offline-cloud/offline-message-log.ts';

function fixture(): { readonly log: OfflineMessageLog; readonly queue: InMemoryFifoQueue } {
  const clock = new VirtualTimeScheduler({ wallEpochMs: 1_000_000 });
  const queue = new InMemoryFifoQueue({
    clock,
    ids: new SequentialUuidSource('abcdabcd'),
    visibilityTimeoutMs: 60_000,
  });
  return { log: new OfflineMessageLog(clock), queue };
}

describe('OfflineMessageLog conformance', () => {
  it('logs each accepted send with its MD5, an increasing 20-digit sequence number and its send time', () => {
    const { log, queue } = fixture();
    const first = log.send(queue, { body: 'one', message_group_id: 'g', message_deduplication_id: 'd1' });
    const second = log.send(queue, { body: 'two', message_group_id: 'g', message_deduplication_id: 'd2' });
    assert.equal(first.md5_of_body, createHash('md5').update('one').digest('hex'));
    assert.match(first.sequence_number, /^\d{20}$/);
    assert.ok(BigInt(second.sequence_number) > BigInt(first.sequence_number));
    assert.equal(first.sent_at_ms, 1_000_000);
    assert.deepEqual(log.find(second.message_id), second);
    assert.equal(log.find('unknown'), undefined);
  });

  it('returns the first message for a deduplicated send', () => {
    const { log, queue } = fixture();
    const first = log.send(queue, { body: 'one', message_group_id: 'g', message_deduplication_id: 'd' });
    assert.deepEqual(log.send(queue, { body: 'one', message_group_id: 'g', message_deduplication_id: 'd' }), first);
  });

  it('keeps only the first receive instant of a message', () => {
    const { log, queue } = fixture();
    const sent = log.send(queue, { body: 'one', message_group_id: 'g', message_deduplication_id: 'd' });
    assert.equal(log.firstReceivedAt(sent.message_id), undefined);
    log.noteReceived(sent.message_id, 5);
    log.noteReceived(sent.message_id, 9);
    assert.equal(log.firstReceivedAt(sent.message_id), 5);
  });
});
