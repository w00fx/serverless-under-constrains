// SQS bindings of the collector's queue ports (design §5.3 `QueueCounterReader`, `DlqCapturePort`;
// §9.4). Thin by construction: each port call sends exactly one request and hands the output to the
// pure parsers outside `aws/` (`parseQueueCounterAttributes`, `mapDlqMessage`), so the decisions
// stay mutation targets (design §15.4). The client is built with `maxAttempts: 1`: a hidden retry of
// ReceiveMessage would add an unrecorded receive to a dead-letter message.

import { GetQueueAttributesCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SQSClientConfig } from '@aws-sdk/client-sqs';

import { err } from '../../record-contract/primitives.ts';
import type { Result } from '../../record-contract/primitives.ts';
import type { QueueCounters } from '../../record-contract/records/group-b/shared-shapes.ts';
import type { CollectorReadFailure } from '../collected-records.ts';
import type { DlqReceiver, ReceivedSqsMessage } from '../dlq-capture.ts';
import { QUEUE_COUNTER_ATTRIBUTES, parseQueueCounterAttributes } from '../queue-observation.ts';
import type { QueueCounterReader } from '../queue-observation.ts';
import { settleSdkCall } from '../sdk-values.ts';

export const COLLECTOR_SQS_CLIENT_OPTIONS = { region: 'us-east-1', maxAttempts: 1 } as const;
const PINNED_SETTING_NAMES: ReadonlySet<string> = new Set(['region', 'maxAttempts', 'retryStrategy', 'retryMode']);

/** Client settings a caller may supply; region and retry behavior are fixed. */
export type CollectorSqsClientSettings = Omit<
  SQSClientConfig,
  'region' | 'maxAttempts' | 'retryStrategy' | 'retryMode'
>;

/** The most messages one ReceiveMessage returns (the SQS limit). */
const RECEIVE_BATCH_SIZE = 10;

/**
 * Builds the SQS client of the collector. Tests pass a scripted `requestHandler` and static
 * credentials; production passes nothing.
 *
 * @example
 * const reader = createSqsQueueCounterReader(createCollectorSqsClient());
 */
export function createCollectorSqsClient(settings: CollectorSqsClientSettings = {}): SQSClient {
  // A cast can smuggle a pinned key past the type, so pinned keys are dropped at run time too.
  const allowed = Object.fromEntries(Object.entries(settings).filter(([name]) => !PINNED_SETTING_NAMES.has(name)));
  return new SQSClient({ ...(allowed as CollectorSqsClientSettings), ...COLLECTOR_SQS_CLIENT_OPTIONS });
}

/**
 * GetQueueAttributes for the three approximate counters.
 *
 * @example
 * await createSqsQueueCounterReader(client).read(queueUrl); // { ok: true, value: { visible: 0, … } }
 */
export function createSqsQueueCounterReader(client: SQSClient): QueueCounterReader {
  return {
    read: async (queueUrl: string): Promise<Result<QueueCounters, CollectorReadFailure>> => {
      const output = await settleSdkCall(() =>
        client.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: Object.values(QUEUE_COUNTER_ATTRIBUTES),
          }),
        ),
      );
      if (!output.ok) {
        return output;
      }
      const counters = parseQueueCounterAttributes(output.value.Attributes);
      return counters.ok ? counters : err({ code: 'QueueAttributesMalformed' });
    },
  };
}

/**
 * ReceiveMessage without deletion: zero visibility timeout, no long poll, every system attribute.
 *
 * @example
 * await createSqsDlqReceiver(client).receiveBatch(dlqUrl); // { ok: true, value: [message, …] }
 */
export function createSqsDlqReceiver(client: SQSClient): DlqReceiver {
  return {
    receiveBatch: async (queueUrl: string): Promise<Result<readonly ReceivedSqsMessage[], CollectorReadFailure>> => {
      const output = await settleSdkCall(() =>
        client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: RECEIVE_BATCH_SIZE,
            VisibilityTimeout: 0,
            WaitTimeSeconds: 0,
            MessageSystemAttributeNames: ['All'],
          }),
        ),
      );
      return output.ok ? { ok: true, value: output.value.Messages ?? [] } : output;
    },
  };
}
