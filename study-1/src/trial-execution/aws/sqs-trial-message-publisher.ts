// The SQS binding of the trial message publisher (design §5.3 `TrialMessagePublisher`, §10.2 T6;
// BR-RUA-020, BR-RUA-036). Thin by construction: one `publish` sends exactly one FIFO
// `SendMessage` with the trial id as both the message group id and the deduplication id, and hands
// what came back to the pure mappers outside `aws/` (send-failure-classification.ts), so the
// decisions stay mutation targets (design §15.4).
//
// The client is the collector's (`createCollectorSqsClient`): region pinned and `maxAttempts: 1`,
// so an ambiguous send is never re-sent as a hidden second publication. The SDK's SQS middleware
// verifies `MD5OfMessageBody` and throws `InvalidChecksumError` on a mismatch after SQS accepted
// the message; the classifier reads that as ambiguous (D-29).
// UNVERIFIED (cloud phase): the definitive-rejection rule of send-failure-classification.ts.

import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';

import { classifySendFailure, sentOutcomeOf } from '../send-failure-classification.ts';
import type { TrialMessagePublisher, TrialMessageSend, TrialMessageSendOutcome } from '../trial-execution-ports.ts';

/**
 * Binds the publisher to `client` (built with `createCollectorSqsClient`).
 *
 * @example
 * const publisher = createSqsTrialMessagePublisher(createCollectorSqsClient());
 * await publisher.publish({ queue_url, body, message_group_id: trialId, message_deduplication_id: trialId });
 */
export function createSqsTrialMessagePublisher(client: SQSClient): TrialMessagePublisher {
  return {
    publish: async (send: TrialMessageSend): Promise<TrialMessageSendOutcome> => {
      const command = new SendMessageCommand({
        QueueUrl: send.queue_url,
        MessageBody: send.body,
        MessageGroupId: send.message_group_id,
        MessageDeduplicationId: send.message_deduplication_id,
      });
      try {
        return sentOutcomeOf(await client.send(command));
      } catch (thrown) {
        const failure = classifySendFailure(thrown);
        return { kind: failure.kind, code: failure.code };
      }
    },
  };
}
