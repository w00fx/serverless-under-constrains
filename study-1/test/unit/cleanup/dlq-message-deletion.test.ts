// Step 8 sweep (BR-RUA-048 "deletes captured run-owned DLQ messages", design §10.4): exactly the
// captured messages are deleted, uncaptured ones are held and released, never deleted, and a
// captured id counts as absent only when every bound queue's sweep proved it gone.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CapturedDlqMessageDeletion,
  DLQ_RECEIVE_BATCH,
  MAX_DLQ_RECEIVES_PER_QUEUE,
} from '../../../src/cleanup/dlq-message-deletion.ts';
import { InMemoryDlqQueue } from '../../support/cleanup/aws/in-memory-dlq-queue.ts';

const HOST = 'https://sqs.us-east-1.amazonaws.com/123456789012';
const FIFO = `${HOST}/suc1-aaaaaaaa-durable-dlq.fifo`;
const OTHER_FIFO = `${HOST}/suc1-aaaaaaaa-conventional-dlq.fifo`;
const STANDARD = `${HOST}/suc1-aaaaaaaa-standard-dlq`;

describe('CapturedDlqMessageDeletion', () => {
  it('deletes the captured messages and releases the uncaptured ones untouched', async () => {
    const queues = new InMemoryDlqQueue();
    queues.enqueue(FIFO, 'm-1', 'g-1');
    queues.enqueue(FIFO, 'u-1', 'g-2');
    queues.enqueue(FIFO, 'm-2', 'g-3');
    const report = await new CapturedDlqMessageDeletion(queues, [FIFO]).deleteCaptured(['m-2', 'm-1']);
    assert.deepEqual(report, { deleted: ['m-1', 'm-2'], absent: [], failed: [] });
    assert.deepEqual(queues.messageIds(FIFO), ['u-1']);
    assert.deepEqual(queues.hiddenIds(FIFO), []);
  });

  it('finds captured messages beyond the first batch by holding what it received', async () => {
    const queues = new InMemoryDlqQueue();
    for (let index = 0; index < 25; index += 1) {
      queues.enqueue(STANDARD, `u-${String(index)}`);
    }
    queues.enqueue(STANDARD, 'm-late');
    const report = await new CapturedDlqMessageDeletion(queues, [STANDARD]).deleteCaptured(['m-late']);
    assert.deepEqual(report, { deleted: ['m-late'], absent: [], failed: [] });
    assert.equal(queues.messageIds(STANDARD).length, 25);
    assert.deepEqual(queues.hiddenIds(STANDARD), []);
  });

  it('reports a captured id absent once a sweep of every bound queue ends empty', async () => {
    const queues = new InMemoryDlqQueue();
    queues.createQueue(FIFO);
    queues.enqueue(STANDARD, 'u-1');
    const report = await new CapturedDlqMessageDeletion(queues, [FIFO, STANDARD]).deleteCaptured(['m-9', 'm-3']);
    assert.deepEqual(report, { deleted: [], absent: ['m-3', 'm-9'], failed: [] });
    assert.deepEqual(queues.messageIds(STANDARD), ['u-1']);
  });

  it('reports a captured id absent when its queue no longer exists', async () => {
    const queues = new InMemoryDlqQueue();
    const report = await new CapturedDlqMessageDeletion(queues, [FIFO]).deleteCaptured(['m-1']);
    assert.deepEqual(report, { deleted: [], absent: ['m-1'], failed: [] });
  });

  it('proves nothing from an empty FIFO receive while it holds a message of some group', async () => {
    const queues = new InMemoryDlqQueue();
    queues.enqueue(FIFO, 'u-1', 'g-1');
    const report = await new CapturedDlqMessageDeletion(queues, [FIFO]).deleteCaptured(['m-1']);
    assert.deepEqual(report.deleted, []);
    assert.deepEqual(report.absent, []);
    assert.deepEqual(
      report.failed.map((failure) => [failure.message_id, failure.reason.code]),
      [['m-1', 'DLQ_MESSAGE_NOT_PROVEN_ABSENT']],
    );
    assert.match(report.failed[0]?.reason.detail ?? '', /DLQ_FIFO_GROUP_HIDDEN/);
    assert.deepEqual(queues.messageIds(FIFO), ['u-1']);
    assert.deepEqual(queues.hiddenIds(FIFO), []);
  });

  it('finds a captured message behind a held one of its FIFO group once that one is deleted', async () => {
    const queues = new InMemoryDlqQueue();
    for (let index = 0; index < 10; index += 1) {
      queues.enqueue(FIFO, `m-${String(index)}`, 'g-1');
    }
    queues.enqueue(FIFO, 'm-10', 'g-1');
    const captured = Array.from({ length: 11 }, (_, index) => `m-${String(index)}`);
    const report = await new CapturedDlqMessageDeletion(queues, [FIFO]).deleteCaptured(captured);
    assert.equal(report.deleted.length, 11);
    assert.deepEqual(queues.messageIds(FIFO), []);
  });

  it('fails every captured id not found when a receive fails, naming the receive failure', async () => {
    const queues = new InMemoryDlqQueue();
    queues.enqueue(FIFO, 'm-1', 'g-1');
    queues.failReceives(OTHER_FIFO);
    queues.createQueue(OTHER_FIFO);
    const report = await new CapturedDlqMessageDeletion(queues, [FIFO, OTHER_FIFO]).deleteCaptured(['m-1', 'm-2']);
    assert.deepEqual(report.deleted, ['m-1']);
    assert.deepEqual(report.absent, []);
    assert.deepEqual(report.failed, [
      {
        message_id: 'm-2',
        reason: {
          code: 'DLQ_MESSAGE_NOT_PROVEN_ABSENT',
          subject: 'm-2',
          detail: `captured message not received, and the sweep proved nothing (OVER_LIMIT on ${OTHER_FIFO}: scripted OVER_LIMIT; expected success); expected a sweep ending in an empty receive`,
        },
      },
    ]);
  });

  it('reports a failed delete with its reason, then releases that message', async () => {
    const queues = new InMemoryDlqQueue();
    queues.enqueue(STANDARD, 'm-1');
    queues.failDeleteOf('m-1');
    const report = await new CapturedDlqMessageDeletion(queues, [STANDARD]).deleteCaptured(['m-1']);
    assert.deepEqual(report, {
      deleted: [],
      absent: [],
      failed: [
        {
          message_id: 'm-1',
          reason: { code: 'INTERNAL_ERROR', subject: 'm-1', detail: 'scripted INTERNAL_ERROR; expected success' },
        },
      ],
    });
    assert.deepEqual(queues.messageIds(STANDARD), ['m-1']);
    assert.deepEqual(queues.hiddenIds(STANDARD), []);
  });

  it('does not report a failed release: the proof was decided before it', async () => {
    const queues = new InMemoryDlqQueue();
    queues.enqueue(STANDARD, 'u-1');
    queues.failReleaseOf('u-1');
    const report = await new CapturedDlqMessageDeletion(queues, [STANDARD]).deleteCaptured(['m-1']);
    assert.deepEqual(report, { deleted: [], absent: ['m-1'], failed: [] });
    assert.deepEqual(
      queues.calls().map((call) => call.operation),
      ['receive', 'receive', 'release'],
    );
  });

  it('stops sweeping once every captured id is deleted, and sweeps nothing for no ids', async () => {
    const queues = new InMemoryDlqQueue();
    queues.enqueue(FIFO, 'm-1', 'g-1');
    queues.enqueue(OTHER_FIFO, 'u-1', 'g-1');
    const deletion = new CapturedDlqMessageDeletion(queues, [FIFO, OTHER_FIFO, FIFO]);
    assert.deepEqual(await deletion.deleteCaptured(['m-1']), { deleted: ['m-1'], absent: [], failed: [] });
    assert.deepEqual(
      queues.calls().map((call) => [call.operation, call.queue_url]),
      [
        ['receive', FIFO],
        ['delete', FIFO],
      ],
    );
    assert.deepEqual(await deletion.deleteCaptured([]), { deleted: [], absent: [], failed: [] });
    assert.equal(queues.calls().length, 2);
  });

  it('deletes a duplicate delivery of a message it already deleted, reporting it once', async () => {
    const queues = new InMemoryDlqQueue();
    queues.enqueue(STANDARD, 'm-1');
    queues.enqueue(STANDARD, 'm-1');
    const report = await new CapturedDlqMessageDeletion(queues, [STANDARD, `${STANDARD}-2`]).deleteCaptured([
      'm-1',
      'm-2',
    ]);
    assert.deepEqual(report, { deleted: ['m-1'], absent: ['m-2'], failed: [] });
    assert.deepEqual(queues.messageIds(STANDARD), []);
  });

  it('fails every captured id when no DLQ is bound', async () => {
    const report = await new CapturedDlqMessageDeletion(new InMemoryDlqQueue(), []).deleteCaptured(['m-1']);
    assert.deepEqual(
      report.failed.map((failure) => failure.reason.code),
      ['DLQ_MESSAGE_NOT_PROVEN_ABSENT'],
    );
    assert.match(report.failed[0]?.reason.detail ?? '', /DLQ_QUEUES_UNBOUND on BR-RUA-048/);
  });

  it('gives a sweep up after the receive budget when the queue never comes back empty', async () => {
    // More uncaptured messages than the budget can hold (20 receives of 10): every receive
    // returns a full batch, so no receive within the budget comes back empty.
    const queues = new InMemoryDlqQueue();
    const backlog = MAX_DLQ_RECEIVES_PER_QUEUE * DLQ_RECEIVE_BATCH + 50;
    for (let index = 0; index < backlog; index += 1) {
      queues.enqueue(STANDARD, `u-${String(index)}`);
    }
    const report = await new CapturedDlqMessageDeletion(queues, [STANDARD]).deleteCaptured(['m-1']);
    const operations = queues.calls().map((call) => call.operation);
    assert.equal(operations.filter((operation) => operation === 'receive').length, MAX_DLQ_RECEIVES_PER_QUEUE);
    assert.equal(
      operations.filter((operation) => operation === 'release').length,
      MAX_DLQ_RECEIVES_PER_QUEUE * DLQ_RECEIVE_BATCH,
    );
    assert.equal(operations.includes('delete'), false, 'an uncaptured message is never deleted');
    assert.deepEqual(report.deleted, []);
    assert.deepEqual(report.absent, []);
    assert.deepEqual(
      report.failed.map((failure) => failure.reason.code),
      ['DLQ_MESSAGE_NOT_PROVEN_ABSENT'],
    );
    assert.match(report.failed[0]?.reason.detail ?? '', /DLQ_SWEEP_INCOMPLETE on https:/);
    assert.equal(queues.messageIds(STANDARD).length, backlog);
    assert.deepEqual(queues.hiddenIds(STANDARD), []);
  });
});
