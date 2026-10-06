// Reading one DynamoDB stream record of the caller journal (design §9.5 controller column,
// F-2). The event source mapping filters to INSERTs of `caller_timeout_recorded`, but a filter
// is configuration, so the controller checks both again before it acts (defense in depth).
// `unmarshallStreamRecord` is total: any input yields a record or a structured reason, never an
// exception, because a stream record the controller cannot read must not loop the shard. The
// record's own members are read only when they are own properties (Owner amendment A-05), and
// the image goes to the store's decoder (WP-04 `decodeStoredItem`), which is total and refuses
// lists and maps nested past DynamoDB's documented 32 levels
// (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html, "Nested
// attribute depth") instead of recursing until the stack overflows. WP-08 review r1 found the
// decoder unbounded and added a second, 64-level walk here; the decoder's own bound replaced it
// (WP-04 review round 1, c1a8514), so this module keeps no nesting rule of its own. Lambda hands
// the handler a JSON-parsed event, which is always a tree, so the bounded decoding is also linear.
//
// The mapping's filter pattern is stated here once as data; the `ExperimentCore` synth test
// compares the template's FilterCriteria with it, so configuration and code cannot drift.

import { decodeStoredItem } from '../durable-store/attribute-value-codec.ts';
import type { StoredItem } from '../durable-store/item-store-port.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import { ownMember } from './own-members.ts';

/** The only record type the controller consumes (BR-RUA-025). */
export const CALLER_TIMEOUT_RECORD_TYPE = 'caller_timeout_recorded';

/** The event source mapping filter pattern (design §9.5): INSERTs of caller timeouts only. */
export const CONTROLLER_STREAM_FILTER = {
  eventName: ['INSERT'],
  dynamodb: { NewImage: { record_type: { S: [CALLER_TIMEOUT_RECORD_TYPE] } } },
} as const;

/** One stream record, reduced to what the controller reads. */
export interface StreamInsertRecord {
  readonly event_name: string;
  readonly new_image: StoredItem;
  readonly sequence_number: string;
}

const MALFORMED = 'STREAM_RECORD_MALFORMED';
const SUBJECT = 'caller_journal_stream_record';

/**
 * Reads a raw DynamoDB stream record (`NEW_IMAGE` view) into its event name, its decoded new
 * image and its sequence number.
 *
 * @example
 * unmarshallStreamRecord({ eventName: 'INSERT', dynamodb: { SequenceNumber: '1', NewImage: { pk: { S: 'p' }, sk: { S: 's' } } } });
 * // { ok: true, value: { event_name: 'INSERT', new_image: { pk: 'p', sk: 's' }, sequence_number: '1' } }
 */
export function unmarshallStreamRecord(raw: unknown): Result<StreamInsertRecord, StructuredReason> {
  if (!isPlainObject(raw)) {
    return malformed(`stream record is ${describeUnknown(raw)}; expected an object`);
  }
  const eventName = ownMember(raw, 'eventName');
  const change = ownMember(raw, 'dynamodb');
  if (typeof eventName !== 'string' || !isPlainObject(change)) {
    return malformed(
      `eventName is ${describeUnknown(eventName)} and dynamodb is ${describeUnknown(change)}; expected a string and an object`,
    );
  }
  const sequenceNumber = ownMember(change, 'SequenceNumber');
  if (typeof sequenceNumber !== 'string') {
    return malformed(`dynamodb.SequenceNumber is ${describeUnknown(sequenceNumber)}; expected a string`);
  }
  const image = decodeStoredItem(ownMember(change, 'NewImage'));
  if (!image.ok) {
    return malformed(`dynamodb.NewImage of ${sequenceNumber}: ${image.error}`);
  }
  return { ok: true, value: { event_name: eventName, new_image: image.value, sequence_number: sequenceNumber } };
}

/**
 * Whether a record is an INSERT of a caller timeout: the only kind the controller acts on.
 *
 * @example
 * isConsumableInsert({ event_name: 'MODIFY', new_image, sequence_number }); // false
 */
export function isConsumableInsert(record: StreamInsertRecord): boolean {
  return record.event_name === 'INSERT' && record.new_image['record_type'] === CALLER_TIMEOUT_RECORD_TYPE;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Names the type only: a hostile value is never stringified or coerced.
function describeUnknown(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

function malformed(detail: string): Result<StreamInsertRecord, StructuredReason> {
  return { ok: false, error: { code: MALFORMED, subject: SUBJECT, detail } };
}
