// The one delivery of the SQS event a Durable execution starts from (design §9.5: event source
// mapping `BatchSize: 1` on a FIFO source, on the `live` alias). The durable SDK hands the
// handler the execution's input payload, which for an SQS mapping is the standard SQS event
// (durable-functions research §2.8, UNVERIFIED until the first deployment). The event is parsed
// totally: a batch of any other size, or a record without a message id, body or receive count,
// is refused with the offending value bounded, never thrown on, because the handler must log a
// structured fault instead of crashing on a shape surprise (A-05: own properties only, kernel
// helpers for every quoted value). The conventional caller's parser has the same shape; design
// §5.4 lets this feature import only `conventional-variant/request-state/`.

import { describeJson, isJsonArray, isJsonObject } from '../record-contract/json-value.ts';
import type { JsonObject, JsonValue, Result } from '../record-contract/primitives.ts';
import { err, ok } from '../record-contract/primitives.ts';
import { ownField } from '../trial-message/trial-message-fields.ts';

/** One SQS delivery, as the Durable caller sees it. */
export interface DurableDelivery {
  readonly message_id: string;
  /** SQS `ApproximateReceiveCount`: 1 on the first receive; a redelivery starts a new execution. */
  readonly approximate_receive_count: number;
  readonly body: string;
}

/** SQS message ids are at most 100 characters; anything longer is no SQS id. */
export const DURABLE_MESSAGE_ID_LIMIT = 128;

// A positive decimal integer without leading zeros and at most 15 digits, so it is a safe integer.
const RECEIVE_COUNT_PATTERN = /^[1-9][0-9]{0,14}$/u;

/**
 * Reads the single delivery of the SQS event a Durable execution started from.
 *
 * @example
 * const delivery = parseDurableSqsDelivery(event);
 * if (!delivery.ok) throw new DurableCallerFault('DELIVERY_INVALID', requestId, delivery.error);
 */
export function parseDurableSqsDelivery(event: JsonValue): Result<DurableDelivery, string> {
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

function deliveryOfRecord(record: JsonObject): Result<DurableDelivery, string> {
  const messageId = ownField(record, 'messageId');
  if (typeof messageId !== 'string' || messageId === '' || messageId.length > DURABLE_MESSAGE_ID_LIMIT) {
    return err(
      `SQS record messageId ${describeJson(messageId)}; expected a string of 1 to ${String(DURABLE_MESSAGE_ID_LIMIT)} characters`,
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
