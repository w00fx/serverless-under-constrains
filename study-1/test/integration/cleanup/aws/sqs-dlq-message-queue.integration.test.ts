// SqsDlqMessageQueue over the real SQS client (BR-RUA-048 step 8): the receive, delete and release
// requests as SQS gets them, and the step-8 sweep of `CapturedDlqMessageDeletion` over them:
// captured messages deleted with their receipt handle, uncaptured ones released, never deleted.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SqsDlqMessageQueue } from '../../../../src/cleanup/aws/sqs-dlq-message-queue.ts';
import {
  CapturedDlqMessageDeletion,
  DLQ_HOLD_VISIBILITY_SECONDS,
  DLQ_RECEIVE_BATCH,
  DLQ_RECEIVE_WAIT_SECONDS,
} from '../../../../src/cleanup/dlq-message-deletion.ts';
import {
  refuse,
  reply,
  ScriptedCleanupEndpoint,
  sqsMessage,
} from '../../../support/cleanup/aws/scripted-cleanup-endpoint.ts';
import { NAMES } from '../../../support/cleanup/cleanup-fixtures.ts';

const URL = NAMES.durableDlqUrl;

describe('SqsDlqMessageQueue', () => {
  it('receives a long-polled batch that it holds for the sweep', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('sqs:ReceiveMessage', reply({ Messages: [sqsMessage('m-1', 'r-1')] }), reply({}));
    const queue = new SqsDlqMessageQueue(endpoint.clients.sqs);
    assert.deepEqual(await queue.receive(URL), {
      kind: 'messages',
      messages: [{ message_id: 'm-1', receipt_handle: 'r-1' }],
    });
    assert.deepEqual(await queue.receive(URL), { kind: 'messages', messages: [] });
    assert.deepEqual(endpoint.calls()[0]?.input, {
      QueueUrl: URL,
      MaxNumberOfMessages: DLQ_RECEIVE_BATCH,
      VisibilityTimeout: DLQ_HOLD_VISIBILITY_SECONDS,
      WaitTimeSeconds: DLQ_RECEIVE_WAIT_SECONDS,
    });
    assert.equal(endpoint.calls()[0]?.region, 'us-east-1');
  });

  it('reads a receive of a queue that no longer exists as absent, and any other failure as failed', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('sqs:ReceiveMessage', refuse('QueueDoesNotExist'), refuse('OverLimit', 'too many'));
    const queue = new SqsDlqMessageQueue(endpoint.clients.sqs);
    assert.deepEqual(await queue.receive(URL), { kind: 'queue_absent' });
    assert.deepEqual(await queue.receive(URL), {
      kind: 'failed',
      reason: {
        code: 'OVER_LIMIT',
        subject: URL,
        detail: 'OverLimit: too many; expected a receive of the dead-letter queue',
      },
    });
  });

  it('deletes by receipt handle and releases with visibility 0', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('sqs:DeleteMessage', reply({}), refuse('ReceiptHandleIsInvalid', 'stale'));
    endpoint.answer('sqs:ChangeMessageVisibility', reply({}));
    const queue = new SqsDlqMessageQueue(endpoint.clients.sqs);
    assert.deepEqual(await queue.deleteMessage(URL, 'r-1'), { kind: 'done' });
    assert.deepEqual(await queue.deleteMessage(URL, 'r-2'), {
      kind: 'failed',
      reason: {
        code: 'RECEIPT_HANDLE_IS_INVALID',
        subject: URL,
        detail: 'ReceiptHandleIsInvalid: stale; expected the captured message to be deleted',
      },
    });
    assert.deepEqual(await queue.releaseMessage(URL, 'r-3'), { kind: 'done' });
    assert.deepEqual(
      endpoint.calls().map((call) => [call.operation, call.input]),
      [
        ['DeleteMessage', { QueueUrl: URL, ReceiptHandle: 'r-1' }],
        ['DeleteMessage', { QueueUrl: URL, ReceiptHandle: 'r-2' }],
        ['ChangeMessageVisibility', { QueueUrl: URL, ReceiptHandle: 'r-3', VisibilityTimeout: 0 }],
      ],
    );
  });

  it('sweeps a DLQ through SQS: deletes the captured message and releases the uncaptured one', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('sqs:ReceiveMessage', reply({ Messages: [sqsMessage('m-1', 'r-1'), sqsMessage('u-1', 'r-2')] }));
    endpoint.answer('sqs:DeleteMessage', reply({}));
    endpoint.answer('sqs:ChangeMessageVisibility', reply({}));
    const deletion = new CapturedDlqMessageDeletion(new SqsDlqMessageQueue(endpoint.clients.sqs), [URL]);
    assert.deepEqual(await deletion.deleteCaptured(['m-1']), { deleted: ['m-1'], absent: [], failed: [] });
    assert.deepEqual(
      endpoint.calls().map((call) => [call.operation, call.input['ReceiptHandle']]),
      [
        ['ReceiveMessage', undefined],
        ['DeleteMessage', 'r-1'],
        ['ChangeMessageVisibility', 'r-2'],
      ],
    );
  });
});
