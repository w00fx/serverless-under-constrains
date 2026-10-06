// Conformance of InMemoryDlqQueue with the SQS behavior the step-8 sweep relies on: a receive
// returns at most ten visible messages and hides them under a fresh receipt handle; a FIFO group
// with a hidden message returns nothing more; delete and release act only through the latest
// receipt handle; an absent queue and scripted faults answer as SQS failures do.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryDlqQueue } from '../../../../support/cleanup/aws/in-memory-dlq-queue.ts';

const STANDARD = 'https://sqs.us-east-1.amazonaws.com/123456789012/standard';
const FIFO = 'https://sqs.us-east-1.amazonaws.com/123456789012/q.fifo';

describe('InMemoryDlqQueue', () => {
  it('receives at most ten visible messages in order, hiding each under a fresh receipt', async () => {
    const queues = new InMemoryDlqQueue();
    for (let index = 0; index < 12; index += 1) {
      queues.enqueue(STANDARD, `m-${String(index)}`);
    }
    const first = await queues.receive(STANDARD);
    assert.ok(first.kind === 'messages');
    assert.equal(first.messages.length, 10);
    assert.equal(new Set(first.messages.map((message) => message.receipt_handle)).size, 10);
    const second = await queues.receive(STANDARD);
    assert.deepEqual(second.kind === 'messages' && second.messages.map((message) => message.message_id), [
      'm-10',
      'm-11',
    ]);
    assert.deepEqual(await queues.receive(STANDARD), { kind: 'messages', messages: [] });
    assert.equal(queues.hiddenIds(STANDARD).length, 12);
  });

  it('returns nothing more of a FIFO group while one of its messages is hidden', async () => {
    const queues = new InMemoryDlqQueue();
    queues.enqueue(FIFO, 'a-1', 'a');
    queues.enqueue(FIFO, 'a-2', 'a');
    const first = await queues.receive(FIFO);
    assert.ok(first.kind === 'messages');
    assert.deepEqual(
      first.messages.map((message) => message.message_id),
      ['a-1', 'a-2'],
    );
    queues.enqueue(FIFO, 'a-3', 'a');
    queues.enqueue(FIFO, 'b-1', 'b');
    const second = await queues.receive(FIFO);
    assert.deepEqual(second.kind === 'messages' && second.messages.map((message) => message.message_id), ['b-1']);
    const [a1, a2] = first.messages;
    assert.ok(a1 !== undefined && a2 !== undefined);
    await queues.deleteMessage(FIFO, a1.receipt_handle);
    await queues.releaseMessage(FIFO, a2.receipt_handle);
    const third = await queues.receive(FIFO);
    assert.deepEqual(third.kind === 'messages' && third.messages.map((message) => message.message_id), ['a-2', 'a-3']);
  });

  it('acts only through the latest receipt handle', async () => {
    const queues = new InMemoryDlqQueue();
    queues.enqueue(STANDARD, 'm-1');
    const first = await queues.receive(STANDARD);
    assert.ok(first.kind === 'messages');
    const stale = first.messages[0]?.receipt_handle ?? '';
    assert.deepEqual(await queues.releaseMessage(STANDARD, stale), { kind: 'done' });
    await queues.receive(STANDARD);
    const refused = await queues.deleteMessage(STANDARD, stale);
    assert.equal(refused.kind === 'failed' && refused.reason.code, 'RECEIPT_HANDLE_IS_INVALID');
    assert.deepEqual(queues.messageIds(STANDARD), ['m-1']);
  });

  it('answers an absent queue and scripted faults', async () => {
    const queues = new InMemoryDlqQueue();
    assert.deepEqual(await queues.receive(STANDARD), { kind: 'queue_absent' });
    queues.enqueue(STANDARD, 'm-1');
    queues.failReceives(STANDARD, 2);
    assert.equal((await queues.receive(STANDARD)).kind, 'failed');
    assert.equal((await queues.receive(STANDARD)).kind, 'failed');
    const received = await queues.receive(STANDARD);
    assert.ok(received.kind === 'messages');
    const receipt = received.messages[0]?.receipt_handle ?? '';
    queues.failDeleteOf('m-1');
    queues.failReleaseOf('m-1');
    assert.equal((await queues.deleteMessage(STANDARD, receipt)).kind, 'failed');
    assert.equal((await queues.releaseMessage(STANDARD, receipt)).kind, 'failed');
    queues.removeQueue(STANDARD);
    assert.deepEqual(await queues.receive(STANDARD), { kind: 'queue_absent' });
    assert.deepEqual(
      queues.calls().map((call) => call.operation),
      ['receive', 'receive', 'receive', 'receive', 'delete', 'release', 'receive'],
    );
  });
});
