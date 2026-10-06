// Conformance of ScriptedSqsClient (design §12.2): its responses are what the SDK's own awsJson1_0
// deserializer accepts as SQS answers — outputs in the documented shapes, a missing queue as the
// SDK's QueueDoesNotExist class, a scripted error by its type — and its queue model behaves as SQS
// does for a receive without delete: the same head messages, at most 10, one more receive counted
// each time, no Messages member when the queue is empty. Operations the collector never sends are
// refused.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  QueueDoesNotExist,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';

import { ScriptedSqsClient } from '../../../support/evidence-collection/scripted-sqs-client.ts';

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-dlq.fifo';

function enqueued(sqs: ScriptedSqsClient, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    sqs.enqueueMessage(QUEUE_URL, {
      MessageId: `m${String(index)}`,
      Body: `body-${String(index)}`,
      Attributes: { ApproximateReceiveCount: '0', MessageGroupId: 'g' },
    });
  }
}

describe('ScriptedSqsClient conformance', () => {
  it('answers GetQueueAttributes with the attribute map, decoded by the SDK', async () => {
    const sqs = new ScriptedSqsClient();
    sqs.setQueueAttributes(QUEUE_URL, { ApproximateNumberOfMessages: '4' });
    const output = await sqs.client.send(new GetQueueAttributesCommand({ QueueUrl: QUEUE_URL }));
    assert.deepEqual(output.Attributes, { ApproximateNumberOfMessages: '4' });
    assert.deepEqual(sqs.calls(), [{ operation: 'GetQueueAttributes', input: { QueueUrl: QUEUE_URL } }]);
  });

  it('receives without delete: the head 10 again, each receive counted, the body digest valid', async () => {
    const sqs = new ScriptedSqsClient();
    enqueued(sqs, 12);
    const receive = new ReceiveMessageCommand({ QueueUrl: QUEUE_URL, MaxNumberOfMessages: 10 });
    await sqs.client.send(receive);
    const output = await sqs.client.send(receive);
    const messages = output.Messages ?? [];
    assert.deepEqual(
      messages.map((message) => message.MessageId),
      ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'],
    );
    assert.equal(messages[0]?.Attributes?.ApproximateReceiveCount, '2');
    assert.equal(messages[0].MD5OfBody, createHash('md5').update('body-1').digest('hex'));
    assert.equal(messages[0].ReceiptHandle, 'receipt-m1');
  });

  it('answers an empty queue without a Messages member', async () => {
    const sqs = new ScriptedSqsClient();
    sqs.setQueueAttributes(QUEUE_URL, {});
    const output = await sqs.client.send(new ReceiveMessageCommand({ QueueUrl: QUEUE_URL }));
    assert.equal(output.Messages, undefined);
  });

  it('fails a missing queue as the SDK QueueDoesNotExist class and a scripted error by its type', async () => {
    const sqs = new ScriptedSqsClient();
    await assert.rejects(
      sqs.client.send(new GetQueueAttributesCommand({ QueueUrl: QUEUE_URL })),
      (error: unknown) => error instanceof QueueDoesNotExist,
    );
    sqs.setQueueAttributes(QUEUE_URL, {});
    sqs.scriptError('RequestThrottled');
    await assert.rejects(sqs.client.send(new ReceiveMessageCommand({ QueueUrl: QUEUE_URL })), {
      name: 'RequestThrottled',
    });
    assert.equal((await sqs.client.send(new ReceiveMessageCommand({ QueueUrl: QUEUE_URL }))).Messages, undefined);
  });

  it('refuses an operation the collector never sends', async () => {
    const sqs = new ScriptedSqsClient();
    enqueued(sqs, 1);
    await assert.rejects(
      sqs.client.send(new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: 'receipt-m1' })),
      { name: 'UnsupportedOperation' },
    );
  });
});
