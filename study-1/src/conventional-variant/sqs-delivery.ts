// The one delivery of a Lambda SQS event (design §9.5: event source mapping `BatchSize: 1` on a
// FIFO source). The event is parsed totally: a batch of any other size, or a record without a
// message id, body or receive count, is refused with the offending value bounded, never thrown
// on, because the handler must log a structured fault instead of crashing on a shape surprise.

import { describeJson, isJsonArray, isJsonObject } from '../record-contract/json-value.ts';
import type { JsonObject, JsonValue, Result } from '../record-contract/primitives.ts';
import { err, ok } from '../record-contract/primitives.ts';
import { ownField } from '../trial-message/trial-message-fields.ts';

/** One SQS delivery, as the consumer sees it (design §5.3). */
export interface DeliveryContext {
  readonly message_id: string;
  /** SQS `ApproximateReceiveCount`: 1 on the first receive. */
  readonly approximate_receive_count: number;
  readonly body: string;
}

/** SQS message ids are at most 100 characters; anything longer is no SQS id. */
export const MESSAGE_ID_LIMIT = 128;

// A positive decimal integer without leading zeros and at most 15 digits, so it is a safe integer.
const RECEIVE_COUNT_PATTERN = /^[1-9][0-9]{0,14}$/u;

/**
 * Reads the single delivery of a Lambda SQS event.
 *
 * @example
 * const delivery = parseSqsDelivery(event);
 * if (delivery.ok) await consumer.consume(delivery.value, context.awsRequestId);
 */
export function parseSqsDelivery(event: JsonValue): Result<DeliveryContext, string> {
  const records = isJsonObject(event) ? ownField(event, 'Records') : undefined;
  if (!isJsonArray(records) || records.length !== 1) {
    return err(`SQS event Records ${describeJson(records)}; expected an array of exactly one record (BatchSize 1)`);
  }
  const [record] = records;
  if (!isJsonObject(record)) {
    return err(`SQS record ${describeJson(record)}; expected a JSON object`);
  }
  return deliveryOfRecord(record);
}

function deliveryOfRecord(record: JsonObject): Result<DeliveryContext, string> {
  const messageId = ownField(record, 'messageId');
  if (typeof messageId !== 'string' || messageId === '' || messageId.length > MESSAGE_ID_LIMIT) {
    return err(
      `SQS record messageId ${describeJson(messageId)}; expected a string of 1 to ${String(MESSAGE_ID_LIMIT)} characters`,
    );
  }
  const body = ownField(record, 'body');
  if (typeof body !== 'string') {
    return err(`SQS record body ${describeJson(body)}; expected a string`);
  }
  const attributes = ownField(record, 'attributes');
  const count = isJsonObject(attributes) ? ownField(attributes, 'ApproximateReceiveCount') : undefined;
  if (typeof count !== 'string' || !RECEIVE_COUNT_PATTERN.test(count)) {
    return err(
      `SQS record attributes.ApproximateReceiveCount ${describeJson(count)}; expected a positive decimal integer string`,
    );
  }
  return ok({ message_id: messageId, approximate_receive_count: Number(count), body });
}
