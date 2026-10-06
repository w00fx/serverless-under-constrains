// The SQS bindings of the collector's queue ports through a real SQSClient (design §5.3, §9.4,
// §12.2): the wire requests (three counters; receive without delete, zero visibility, no long
// poll, every system attribute), the pinned client options, errors by their SDK names, the SDK's
// own MD5-of-body check, and the DLQ capture driven end to end through the binding.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COLLECTOR_SQS_CLIENT_OPTIONS,
  createCollectorSqsClient,
  createSqsDlqReceiver,
  createSqsQueueCounterReader,
} from '../../../../src/evidence-collection/aws/sqs-collector.ts';
import type { CollectorSqsClientSettings } from '../../../../src/evidence-collection/aws/sqs-collector.ts';
import { captureDlq, mapDlqMessage } from '../../../../src/evidence-collection/dlq-capture.ts';
import { QUEUE_COUNTER_ATTRIBUTES } from '../../../../src/evidence-collection/queue-observation.ts';
import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import {
  assertValidRecord,
  collectionClock,
  TRIAL_ID,
  TRIAL_SCOPE,
} from '../../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedSqsClient } from '../../../support/evidence-collection/scripted-sqs-client.ts';

const SOURCE_URL = 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-source.fifo';
const DLQ_URL = 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-dlq.fifo';
const OTHER_TRIAL = '00000000-0000-4000-8000-000000000204';

const COUNTER_ATTRIBUTES = {
  ApproximateNumberOfMessages: '2',
  ApproximateNumberOfMessagesNotVisible: '1',
  ApproximateNumberOfMessagesDelayed: '0',
};

function wireMessage(id: string, group: string): Parameters<ScriptedSqsClient['enqueueMessage']>[1] {
  return {
    MessageId: id,
    Body: `{"trial_id":"${group}"}`,
    Attributes: {
      ApproximateReceiveCount: '2',
      ApproximateFirstReceiveTimestamp: String(Date.UTC(2026, 9, 5, 12, 35, 5, 400)),
      SentTimestamp: String(Date.UTC(2026, 9, 5, 12, 35, 5)),
      MessageGroupId: group,
      MessageDeduplicationId: `${group}-${id}`,
      SequenceNumber: '18000000000002100000',
    },
  };
}

describe('createCollectorSqsClient', () => {
  it('pins us-east-1 and a single attempt, even against a smuggled override', async () => {
    const smuggled = { region: 'eu-west-1', maxAttempts: 5 } as unknown as CollectorSqsClientSettings;
    const client = createCollectorSqsClient(smuggled);
    assert.equal(await client.config.region(), COLLECTOR_SQS_CLIENT_OPTIONS.region);
    assert.equal(await client.config.maxAttempts(), 1);
  });

  it('sends a retryable failure once: no hidden retry adds a receive', async () => {
    const sqs = new ScriptedSqsClient();
    sqs.setQueueAttributes(DLQ_URL, {});
    sqs.scriptError('InternalError', 500);
    const received = await createSqsDlqReceiver(sqs.client).receiveBatch(DLQ_URL);
    assert.deepEqual(received, { ok: false, error: { code: 'InternalError' } });
    assert.equal(sqs.calls().length, 1);
  });
});

describe('createSqsQueueCounterReader', () => {
  it('asks for exactly the three approximate counters and parses them', async () => {
    const sqs = new ScriptedSqsClient();
    sqs.setQueueAttributes(SOURCE_URL, COUNTER_ATTRIBUTES);
    const read = await createSqsQueueCounterReader(sqs.client).read(SOURCE_URL);
    assert.deepEqual(read, { ok: true, value: { visible: 2, in_flight: 1, delayed: 0 } });
    assert.deepEqual(sqs.calls(), [
      {
        operation: 'GetQueueAttributes',
        input: { QueueUrl: SOURCE_URL, AttributeNames: Object.values(QUEUE_COUNTER_ATTRIBUTES) },
      },
    ]);
  });

  it('refuses an attribute map without a counter as QueueAttributesMalformed', async () => {
    const sqs = new ScriptedSqsClient();
    sqs.setQueueAttributes(SOURCE_URL, { ApproximateNumberOfMessages: '2' });
    const read = await createSqsQueueCounterReader(sqs.client).read(SOURCE_URL);
    assert.deepEqual(read, { ok: false, error: { code: 'QueueAttributesMalformed' } });
  });

  it('reports a missing queue and a throttle by their SDK error names', async () => {
    const sqs = new ScriptedSqsClient();
    const reader = createSqsQueueCounterReader(sqs.client);
    assert.deepEqual(await reader.read(SOURCE_URL), { ok: false, error: { code: 'QueueDoesNotExist' } });
    sqs.setQueueAttributes(SOURCE_URL, COUNTER_ATTRIBUTES);
    sqs.scriptError('ThrottlingException');
    assert.deepEqual(await reader.read(SOURCE_URL), { ok: false, error: { code: 'ThrottlingException' } });
  });
});

describe('createSqsDlqReceiver', () => {
  it('receives without delete: zero visibility, no long poll, at most 10, every system attribute', async () => {
    const sqs = new ScriptedSqsClient();
    sqs.enqueueMessage(DLQ_URL, wireMessage('m1', TRIAL_ID));
    const received = await createSqsDlqReceiver(sqs.client).receiveBatch(DLQ_URL);
    assert.ok(received.ok);
    assert.equal(received.value.length, 1);
    assert.deepEqual(sqs.calls(), [
      {
        operation: 'ReceiveMessage',
        input: {
          QueueUrl: DLQ_URL,
          MaxNumberOfMessages: 10,
          VisibilityTimeout: 0,
          WaitTimeSeconds: 0,
          MessageSystemAttributeNames: ['All'],
        },
      },
    ]);
  });

  it('yields entries the pure mapper accepts, each receive counted', async () => {
    const sqs = new ScriptedSqsClient();
    sqs.enqueueMessage(DLQ_URL, wireMessage('m1', TRIAL_ID));
    const receiver = createSqsDlqReceiver(sqs.client);
    await receiver.receiveBatch(DLQ_URL);
    const second = await receiver.receiveBatch(DLQ_URL);
    assert.ok(second.ok);
    const [entry] = second.value;
    assert.ok(entry !== undefined);
    const mapped = mapDlqMessage(entry);
    assert.ok(mapped.ok);
    assert.equal(mapped.value.message_id, 'm1');
    assert.equal(mapped.value.message_group_id, TRIAL_ID);
    assert.equal(mapped.value.approximate_receive_count, 4);
  });

  it('answers an empty queue with no messages', async () => {
    const sqs = new ScriptedSqsClient();
    sqs.setQueueAttributes(DLQ_URL, {});
    assert.deepEqual(await createSqsDlqReceiver(sqs.client).receiveBatch(DLQ_URL), { ok: true, value: [] });
  });

  it('fails a receive whose body does not match its MD5 (the SDK check), never returning the body', async () => {
    const sqs = new ScriptedSqsClient();
    sqs.enqueueMessage(DLQ_URL, { ...wireMessage('m1', TRIAL_ID), MD5OfBody: '00000000000000000000000000000000' });
    const received = await createSqsDlqReceiver(sqs.client).receiveBatch(DLQ_URL);
    // The SDK throws a plain Error for the mismatch; its name is the only code it carries.
    assert.deepEqual(received, { ok: false, error: { code: 'Error' } });
  });
});

describe('captureDlq through the SQS binding', () => {
  it('snapshots only the trial messages and reports every captured id', async () => {
    const sqs = new ScriptedSqsClient();
    sqs.enqueueMessage(DLQ_URL, wireMessage('m1', TRIAL_ID));
    sqs.enqueueMessage(DLQ_URL, wireMessage('m2', OTHER_TRIAL));
    const capture = await captureDlq(
      createSqsDlqReceiver(sqs.client),
      { queue_url: DLQ_URL, queue_name: 'suc1-dlq.fifo' },
      TRIAL_SCOPE,
      collectionClock(),
    );
    assert.deepEqual(capture.failures, []);
    assert.equal(capture.receive_complete, true);
    assert.deepEqual(capture.correlated_message_ids, ['m1']);
    assert.deepEqual([...capture.captured_message_ids].sort(), ['m1', 'm2']);
    assertValidRecord(capture.record, 'dlq_snapshot');
    const messages = capture.record['messages'] as readonly JsonObject[];
    assert.deepEqual(
      messages.map((message) => message['message_id']),
      ['m1'],
    );
  });
});
