// One Lambda SQS event through the consumer, as the event source mapping sees it: the promise
// resolves when the delivery completed (the mapping deletes the message) and rejects when it did
// not (the message returns after the visibility timeout, BR-RUA-020). The handler adds only the
// lazy wiring and the log line, so offline tests drive this exact path through the FIFO
// emulator.

import type { JsonValue } from '../record-contract/primitives.ts';
import type { ConventionalRefundConsumer } from './conventional-consumer.ts';
import { ConventionalCallerFault, DeliveryFailurePropagated } from './conventional-fault.ts';
import { parseSqsDelivery } from './sqs-delivery.ts';

/**
 * Consumes the single delivery of `event`. Rejects with a ConventionalCallerFault
 * (`DELIVERY_INVALID` for an event that is no single SQS delivery, or the consumer's own fault)
 * or a DeliveryFailurePropagated when the attempt asks SQS to redeliver.
 *
 * @example
 * await consumeSqsEvent(consumer, event, context.awsRequestId); // resolved: the message is deleted
 */
export async function consumeSqsEvent(
  consumer: ConventionalRefundConsumer,
  event: JsonValue,
  lambdaRequestId: string,
): Promise<void> {
  const delivery = parseSqsDelivery(event);
  if (!delivery.ok) {
    throw new ConventionalCallerFault('DELIVERY_INVALID', lambdaRequestId, delivery.error);
  }
  const disposition = await consumer.consume(delivery.value, lambdaRequestId);
  if (disposition.kind === 'propagate_failure') {
    const { message_id, approximate_receive_count } = delivery.value;
    throw new DeliveryFailurePropagated(lambdaRequestId, message_id, approximate_receive_count);
  }
}
