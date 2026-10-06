// Conformance of ScriptedDlqReceiver (design §12.2): in `head` mode its batches are what the real
// SQS binding returns through a real SQSClient for a queue received without delete — the same head
// messages on every receive, at most 10, each receive counted — once both are mapped to snapshot
// entries (the binding's entries also carry a receipt handle the collector never reads). The
// `rotating` mode and receive-numbered failures have no real counterpart: they emulate a queue
// whose visible window moves and a service failing one particular receive.
//
// Sources (RK-17): [R-aws] §3 (a FIFO dead-letter queue keeps the original message id; FIFO
// receives return a group's messages in order and no more of that group while one is in flight);
// https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html
// (`MaxNumberOfMessages` 1 to 10; `ApproximateReceiveCount` counts every receive not followed by
// a delete; `VisibilityTimeout` is how long a received message stays hidden, so 0 hides it from
// no later receive).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { createSqsDlqReceiver } from '../../../../src/evidence-collection/aws/sqs-collector.ts';
import { mapDlqMessage } from '../../../../src/evidence-collection/dlq-capture.ts';
import type { DlqReceiver, ReceivedSqsMessage } from '../../../../src/evidence-collection/dlq-capture.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { sqsMessage, TRIAL_ID } from '../../../support/evidence-collection/collection-fixtures.ts';
import { DLQ_BATCH_LIMIT, ScriptedDlqReceiver } from '../../../support/evidence-collection/scripted-dlq-receiver.ts';
import { ScriptedSqsClient } from '../../../support/evidence-collection/scripted-sqs-client.ts';

const DLQ_URL = 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-dlq.fifo';

function wireOf(message: ReceivedSqsMessage): Parameters<ScriptedSqsClient['enqueueMessage']>[1] {
  return {
    MessageId: message.MessageId as string,
    Body: message.Body as string,
    Attributes: message.Attributes as Readonly<Record<string, string>>,
  };
}

async function mappedBatch(receiver: DlqReceiver): Promise<JsonValue> {
  const batch = await receiver.receiveBatch(DLQ_URL);
  if (!batch.ok) {
    return { failed: batch.error.code };
  }
  return batch.value.map((message) => {
    const mapped = mapDlqMessage(message);
    return mapped.ok ? { ...mapped.value } : mapped.error;
  });
}

function bothQueues(count: number): { readonly fake: ScriptedDlqReceiver; readonly real: DlqReceiver } {
  const fake = new ScriptedDlqReceiver();
  const sqs = new ScriptedSqsClient();
  sqs.setQueueAttributes(DLQ_URL, {});
  for (let index = 1; index <= count; index += 1) {
    // The fixture's MD5 is a placeholder; the real queue computes it from the body, so the fake
    // message carries the true digest too.
    const fixture = sqsMessage({ id: `m${String(index)}`, group: TRIAL_ID, receiveCount: 1 });
    const message = {
      ...fixture,
      MD5OfBody: createHash('md5')
        .update(fixture.Body as string, 'utf8')
        .digest('hex'),
    };
    fake.enqueue(message);
    sqs.enqueueMessage(DLQ_URL, wireOf(message));
  }
  return { fake, real: createSqsDlqReceiver(sqs.client) };
}

describe('ScriptedDlqReceiver conformance', () => {
  it('returns the same head messages again on each receive, counting each, as the real queue', async () => {
    const { fake, real } = bothQueues(2);
    for (let receive = 1; receive <= 3; receive += 1) {
      const fakeBatch = await mappedBatch(fake);
      const realBatch = await mappedBatch(real);
      assert.deepEqual(fakeBatch, realBatch, `receive ${String(receive)}`);
    }
    assert.equal(fake.receiveCount(), 3);
  });

  it('caps a batch at the SQS limit of 10, as the real queue', async () => {
    const { fake, real } = bothQueues(DLQ_BATCH_LIMIT + 3);
    const fakeBatch = await mappedBatch(fake);
    assert.deepEqual(fakeBatch, await mappedBatch(real));
    assert.equal((fakeBatch as readonly JsonValue[]).length, DLQ_BATCH_LIMIT);
  });

  it('answers an empty queue with an empty batch, as the real queue', async () => {
    const { fake, real } = bothQueues(0);
    assert.deepEqual(await mappedBatch(fake), await mappedBatch(real));
    assert.deepEqual(await mappedBatch(fake), []);
  });

  it('fails exactly the scripted receive with the bare code', async () => {
    const fake = new ScriptedDlqReceiver();
    fake.enqueue(sqsMessage({ id: 'm1', group: TRIAL_ID }));
    fake.scriptFailure('KmsThrottled', 2);
    fake.scriptFailure('OverLimit');
    assert.deepEqual(await fake.receiveBatch(DLQ_URL), { ok: false, error: { code: 'OverLimit' } });
    assert.deepEqual(await fake.receiveBatch(DLQ_URL), { ok: false, error: { code: 'KmsThrottled' } });
    assert.equal((await fake.receiveBatch(DLQ_URL)).ok, true);
  });

  it('rotating mode starts each receive one batch further, modulo the queue length', async () => {
    const fake = new ScriptedDlqReceiver('rotating');
    for (let index = 1; index <= DLQ_BATCH_LIMIT + 2; index += 1) {
      fake.enqueue(sqsMessage({ id: `m${String(index)}`, group: TRIAL_ID }));
    }
    const ids = async (): Promise<readonly unknown[]> => {
      const batch = await fake.receiveBatch(DLQ_URL);
      return batch.ok ? batch.value.map((message) => message.MessageId) : [];
    };
    assert.equal((await ids()).length, DLQ_BATCH_LIMIT);
    assert.deepEqual(await ids(), ['m11', 'm12']);
    assert.deepEqual(await ids(), ['m9', 'm10', 'm11', 'm12']);
  });

  it('leaves a message with malformed attributes unchanged on receive', async () => {
    const fake = new ScriptedDlqReceiver();
    const hostile: ReceivedSqsMessage[] = [
      { MessageId: 'a', Attributes: 'not-a-map' },
      { MessageId: 'b', Attributes: { SentTimestamp: '1' } },
      { MessageId: 'c', Attributes: { ApproximateReceiveCount: 'many' } },
    ];
    for (const message of hostile) {
      fake.enqueue(message);
    }
    const batch = await fake.receiveBatch(DLQ_URL);
    assert.deepEqual(batch, { ok: true, value: hostile });
  });
});
