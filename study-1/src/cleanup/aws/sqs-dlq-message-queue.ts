// SQS binding of `DlqQueueAccess`, the three calls of the step-8 sweep that
// `dlq-message-deletion.ts` decides over (BR-RUA-048 step 8, design §10.4). Thin by construction:
// one request per call, the settled result handed to `sdk-call-outcomes.ts`.
// - `ReceiveMessage` hides what it returns for the sweep's hold timeout, so the next receive
//   returns other messages and the sweep's delete or release acts on a message nobody else
//   received meanwhile, and long-polls, so an empty answer means no message is visible rather
//   than a sampled miss;
// - `DeleteMessage` uses the receipt handle of this receive;
// - `ChangeMessageVisibility(0)` releases a held message at once.
//
// `DeleteMessage` through an old receipt handle "will succeed, but the message might not be
// deleted" (SQS API reference, API_DeleteMessage, read 2026-10-06), so a `done` delete is only
// as good as its handle: the sweep deletes a captured message with the handle of the receive
// that just returned it, inside that receive's hold, which is then the latest handle.
//
// UNVERIFIED (cloud phase): that a long-polled empty receive of a FIFO DLQ with no message in
// flight proves it holds none.

import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';

import type { DlqMessageChange, DlqQueueAccess, DlqReceive } from '../dlq-message-deletion.ts';
import { DLQ_HOLD_VISIBILITY_SECONDS, DLQ_RECEIVE_BATCH, DLQ_RECEIVE_WAIT_SECONDS } from '../dlq-message-deletion.ts';
import { dlqChangeOutcome, dlqReceiveOutcome, settleCleanupCall } from '../sdk-call-outcomes.ts';

/**
 * DLQ receives, deletes and releases through SQS.
 *
 * @example
 * const port = new CapturedDlqMessageDeletion(new SqsDlqMessageQueue(clients.sqs), targets.dlq_urls);
 */
export class SqsDlqMessageQueue implements DlqQueueAccess {
  readonly #sqs: SQSClient;

  constructor(sqs: SQSClient) {
    this.#sqs = sqs;
  }

  /** One long-polled receive of at most ten messages, each hidden for the hold timeout. */
  async receive(queueUrl: string): Promise<DlqReceive> {
    const call = await settleCleanupCall(() =>
      this.#sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: DLQ_RECEIVE_BATCH,
          VisibilityTimeout: DLQ_HOLD_VISIBILITY_SECONDS,
          WaitTimeSeconds: DLQ_RECEIVE_WAIT_SECONDS,
        }),
      ),
    );
    return dlqReceiveOutcome(call, queueUrl);
  }

  /** Deletes one received message by its receipt handle. */
  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<DlqMessageChange> {
    const call = await settleCleanupCall(() =>
      this.#sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle })),
    );
    return dlqChangeOutcome(call, queueUrl, 'the captured message to be deleted');
  }

  /** Makes one received message visible again at once. */
  async releaseMessage(queueUrl: string, receiptHandle: string): Promise<DlqMessageChange> {
    const call = await settleCleanupCall(() =>
      this.#sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: 0 }),
      ),
    );
    return dlqChangeOutcome(call, queueUrl, 'the message to be released');
  }
}
