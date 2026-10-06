// A variant's message source (design §9.5): an SQS FIFO queue with content-based deduplication
// off (the runner sets `MessageDeduplicationId = trial_id`), the variant's visibility timeout,
// and a FIFO dead-letter queue that receives the message once its receive count exceeds
// `maxReceiveCount = 2` (OR-RUA-002: one initial delivery plus one redelivery, BR-RUA-020). Both
// queues carry deterministic names (BR-RUA-050) and are removed with the stack. The Durable
// variant reuses it with its own visibility timeout.

import { RemovalPolicy } from 'aws-cdk-lib';
import type { Duration } from 'aws-cdk-lib';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import type { VariantId } from '../../src/record-contract/primitives.ts';
import type { ExecutionSynthContext } from '../ownership/execution-context.ts';
import { queueName } from '../ownership/resource-naming.ts';

/** OR-RUA-002: receives of one message before the redrive moves it to the DLQ. */
export const SOURCE_MAX_RECEIVE_COUNT = 2;

export interface FifoMessageSourceProps {
  readonly context: ExecutionSynthContext;
  readonly variant: VariantId;
  /** At least the consuming function's timeout; AWS recommends six times it (aws-semantics §3). */
  readonly visibilityTimeout: Duration;
}

/**
 * The FIFO source queue of one variant and its FIFO dead-letter queue.
 *
 * @example
 * const source = new FifoMessageSource(this, 'Source', { context, variant: 'conventional', visibilityTimeout: Duration.seconds(60) });
 * alias.addEventSource(new SqsEventSource(source.queue, { batchSize: 1 }));
 */
export class FifoMessageSource extends Construct {
  readonly queue: Queue;
  readonly deadLetterQueue: Queue;

  constructor(scope: Construct, id: string, props: FifoMessageSourceProps) {
    super(scope, id);
    const executionId = props.context.execution_id;
    this.deadLetterQueue = new Queue(this, 'DeadLetterQueue', {
      queueName: queueName(executionId, props.variant, 'dlq'),
      fifo: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.queue = new Queue(this, 'Queue', {
      queueName: queueName(executionId, props.variant, 'source'),
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: props.visibilityTimeout,
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: SOURCE_MAX_RECEIVE_COUNT },
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
