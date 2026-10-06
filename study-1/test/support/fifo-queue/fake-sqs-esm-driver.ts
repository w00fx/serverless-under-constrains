// Offline stand-in for the Lambda SQS event source mapping on a FIFO source (design §12.2,
// design/aws-semantics.md §3): each poll receives at most one message (`BatchSize: 1`), invokes
// the function with the Lambda SQS event of that message, deletes the message when the
// invocation succeeds, and leaves it in flight when the invocation fails, so it returns after
// the visibility timeout. `throttleNext` makes the next poll receive a message without invoking
// the function, as a Lambda throttle does: the receive still counts toward `maxReceiveCount`
// (RK-08; AWS recommends `maxReceiveCount >= 5` for this reason).

import { createHash } from 'node:crypto';

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { FifoReceivedMessage, InMemoryFifoQueue } from './in-memory-fifo-queue.ts';

/** The function the mapping invokes: resolves on success, rejects on an invocation failure. */
export type SqsFunction = (event: JsonValue, context: { readonly awsRequestId: string }) => Promise<void>;

export type PollResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'throttled'; readonly message_id: string; readonly receive_count: number }
  | { readonly kind: 'completed'; readonly message_id: string; readonly receive_count: number }
  | { readonly kind: 'failed'; readonly message_id: string; readonly receive_count: number; readonly error: unknown };

export interface SqsEsmDriverOptions {
  readonly queue: InMemoryFifoQueue;
  readonly invoke: SqsFunction;
  /** The source queue ARN the event names. */
  readonly event_source_arn: string;
}

export class FakeSqsEsmDriver {
  readonly #options: SqsEsmDriverOptions;
  readonly #requestIds: string[] = [];
  #throttles = 0;

  constructor(options: SqsEsmDriverOptions) {
    this.#options = options;
  }

  /** The next poll that receives a message consumes the receive without invoking (RK-08). */
  throttleNext(): void {
    this.#throttles += 1;
  }

  /** The Lambda request ids of every invocation so far, in order. */
  requestIds(): readonly string[] {
    return [...this.#requestIds];
  }

  /**
   * One poll: receive, then invoke and delete on success.
   *
   * @example
   * const result = await driver.pollOnce(); // { kind: 'failed', ... } leaves the message in flight
   */
  async pollOnce(): Promise<PollResult> {
    const message = this.#options.queue.receive();
    if (message === undefined) {
      return { kind: 'empty' };
    }
    const facts = { message_id: message.message_id, receive_count: message.approximate_receive_count };
    if (this.#throttles > 0) {
      this.#throttles -= 1;
      return { kind: 'throttled', ...facts };
    }
    const awsRequestId = `lambda-request-${String(this.#requestIds.length + 1).padStart(4, '0')}`;
    this.#requestIds.push(awsRequestId);
    try {
      await this.#options.invoke(sqsLambdaEvent(message, this.#options.event_source_arn), { awsRequestId });
    } catch (error: unknown) {
      return { kind: 'failed', ...facts, error };
    }
    this.#options.queue.deleteMessage(message.receipt_handle);
    return { kind: 'completed', ...facts };
  }
}

/**
 * The Lambda SQS event of one received FIFO message (the `aws:sqs` record shape).
 *
 * @example
 * sqsLambdaEvent(message, arn).Records[0].attributes.ApproximateReceiveCount; // '1'
 */
export function sqsLambdaEvent(message: FifoReceivedMessage, eventSourceArn: string): JsonValue {
  return {
    Records: [
      {
        messageId: message.message_id,
        receiptHandle: message.receipt_handle,
        body: message.body,
        attributes: {
          ApproximateReceiveCount: String(message.approximate_receive_count),
          SentTimestamp: String(message.sent_at_ms),
          SenderId: 'AROAEXAMPLE:runner',
          ApproximateFirstReceiveTimestamp: String(message.first_received_at_ms),
          MessageGroupId: message.message_group_id,
          MessageDeduplicationId: message.message_deduplication_id,
        },
        messageAttributes: {},
        md5OfBody: createHash('md5').update(message.body).digest('hex'),
        eventSource: 'aws:sqs',
        eventSourceARN: eventSourceArn,
        awsRegion: 'us-east-1',
      },
    ],
  };
}
