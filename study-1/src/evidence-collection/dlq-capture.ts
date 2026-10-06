// The conditional DLQ capture (design §5.3 `DlqCapturePort`, §7 `queues/dlq-snapshot.json`;
// BR-RUA-032, BR-RUA-037, BR-RUA-048 step 7). The collector receives dead-letter messages without
// deleting them: deletion is cleanup step 8 and covers only captured messages. Every trial message
// carries its trial id as `MessageGroupId` (BR-RUA-020), so a message is correlated with the trial
// exactly when its group id is the trial id.
//
// The receiver uses a zero visibility timeout, so a received message stays visible and the next
// receive returns the same head messages again. Capture therefore runs receive rounds until a round
// returns nothing it has not already seen (or nothing at all), which is how it knows it drained the
// visible messages; a round limit bounds the loop. A failed receive, a malformed message or an
// exhausted round limit leaves `receive_complete` false and records why: a settlement sample then
// counts the uncaptured messages and stays not quiet (§8.12).

import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonObject, Result, StructuredReason, WallClock } from '../record-contract/primitives.ts';
import type { DlqMessage } from '../record-contract/records/group-b/dlq_snapshot.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { correlationFields } from './capture-scope.ts';
import type { TrialCaptureScope } from './capture-scope.ts';
import { readFailure } from './collected-records.ts';
import type { CollectorReadFailure } from './collected-records.ts';
import type { QueueTarget } from './queue-observation.ts';
import { digitCount, instantOfEpochText, nonEmptyString, ownValue, quoted } from './sdk-values.ts';

/** One received SQS message as the SDK returns it; every member is untrusted. */
export interface ReceivedSqsMessage {
  readonly MessageId?: unknown;
  readonly Body?: unknown;
  readonly MD5OfBody?: unknown;
  readonly Attributes?: unknown;
}

/** One `ReceiveMessage` without deletion, with a zero visibility timeout and every attribute. */
export interface DlqReceiver {
  receiveBatch(queueUrl: string): Promise<Result<readonly ReceivedSqsMessage[], CollectorReadFailure>>;
}

/** The capture: the `dlq_snapshot` record and the message ids settlement reads. */
export interface DlqCapture {
  /** The snapshot of the correlated messages (catalogue row 59). */
  readonly record: JsonObject;
  /** Captured messages whose group id is the trial id, in receive order. */
  readonly correlated_message_ids: readonly string[];
  /** Every captured message, correlated or not: what the DLQ counters are compared with. */
  readonly captured_message_ids: readonly string[];
  readonly receive_complete: boolean;
  readonly failures: readonly StructuredReason[];
}

/** The most receive rounds one capture makes before it reports the receive incomplete. */
export const DLQ_RECEIVE_ROUND_LIMIT = 10;

const MD5_HEX = /^[0-9a-f]{32}$/;
// FIFO sequence numbers are 128-bit decimal strings, beyond the safe integers, so they stay text.
const SEQUENCE_NUMBER = /^[0-9]+$/;
const encoder = new TextEncoder();

type DlqMessageAttributes = Omit<DlqMessage, 'message_id' | 'body' | 'body_sha256' | 'md5_of_body'>;

interface CaptureState {
  readonly messages: Map<string, DlqMessage>;
  readonly failures: StructuredReason[];
  complete: boolean;
}

/**
 * Receives the DLQ's visible messages without deleting them and snapshots those of the trial.
 *
 * @example
 * const capture = await captureDlq(receiver, { queue_url, queue_name }, scope, clock);
 * capture.correlated_message_ids; // ['caee084c-…'] after a redrive
 */
export async function captureDlq(
  receiver: DlqReceiver,
  target: QueueTarget,
  scope: TrialCaptureScope,
  clock: WallClock,
): Promise<DlqCapture> {
  const state: CaptureState = { messages: new Map(), failures: [], complete: false };
  await receiveRounds(receiver, target, state);
  const captured = [...state.messages.values()];
  const correlated = captured.filter((message) => message.message_group_id === scope.unit.trial_id);
  return {
    record: {
      schema_version: 1,
      record_type: 'dlq_snapshot',
      ...correlationFields(scope),
      queue_name: target.queue_name,
      captured_at: formatUtcMillis(clock.now()),
      receive_complete: state.complete,
      messages: correlated.map((message) => ({ ...message })),
    },
    correlated_message_ids: correlated.map((message) => message.message_id),
    captured_message_ids: captured.map((message) => message.message_id),
    receive_complete: state.complete,
    failures: state.failures,
  };
}

/**
 * Maps one received message to its snapshot entry, refusing any member outside the SQS shape.
 *
 * @example
 * mapDlqMessage(received).ok; // false when SentTimestamp is not an epoch-millisecond string
 */
export function mapDlqMessage(received: ReceivedSqsMessage): Result<DlqMessage, string> {
  const messageId = nonEmptyString(ownValue(received, 'MessageId'));
  const body = ownValue(received, 'Body');
  const md5 = ownValue(received, 'MD5OfBody');
  if (messageId === undefined) {
    return err(`MessageId is ${quoted(ownValue(received, 'MessageId'))}; expected a non-empty string`);
  }
  if (typeof body !== 'string') {
    return err(`Body is ${quoted(body)}; expected a string`);
  }
  if (typeof md5 !== 'string' || !MD5_HEX.test(md5)) {
    return err(`MD5OfBody is ${quoted(md5)}; expected 32 lowercase hexadecimal digits`);
  }
  const attributes = attributesOf(ownValue(received, 'Attributes'));
  if (!attributes.ok) {
    return attributes;
  }
  return ok({
    message_id: messageId,
    body,
    body_sha256: sha256Hex(encoder.encode(body)),
    md5_of_body: md5,
    ...attributes.value,
  });
}

async function receiveRounds(receiver: DlqReceiver, target: QueueTarget, state: CaptureState): Promise<void> {
  for (let round = 1; round <= DLQ_RECEIVE_ROUND_LIMIT; round += 1) {
    const batch = await receiver.receiveBatch(target.queue_url);
    if (!batch.ok) {
      state.failures.push(readFailure('DLQ_RECEIVE_FAILED', 'dlq', target.queue_name, batch.error, round));
      return;
    }
    if (!keepNewMessages(batch.value, target, state)) {
      state.complete = state.failures.length === 0;
      return;
    }
  }
  state.failures.push({
    code: 'DLQ_RECEIVE_ROUNDS_EXHAUSTED',
    subject: 'BR-RUA-037',
    detail: `dlq ${target.queue_name} still returned unseen messages after ${String(DLQ_RECEIVE_ROUND_LIMIT)} receive rounds; expected a round with no unseen message`,
  });
}

// Keeps every well-formed message not seen before; true when the round brought one.
function keepNewMessages(batch: readonly ReceivedSqsMessage[], target: QueueTarget, state: CaptureState): boolean {
  let unseen = false;
  for (const received of batch) {
    const mapped = mapDlqMessage(received);
    if (!mapped.ok) {
      state.failures.push(malformed(target, received, mapped.error));
      continue;
    }
    if (!state.messages.has(mapped.value.message_id)) {
      state.messages.set(mapped.value.message_id, mapped.value);
      unseen = true;
    }
  }
  return unseen;
}

function attributesOf(attributes: unknown): Result<DlqMessageAttributes, string> {
  const count = digitCount(ownValue(attributes, 'ApproximateReceiveCount'), 1);
  const firstReceive = instantOfEpochText(ownValue(attributes, 'ApproximateFirstReceiveTimestamp'));
  const sent = instantOfEpochText(ownValue(attributes, 'SentTimestamp'));
  const group = nonEmptyString(ownValue(attributes, 'MessageGroupId'));
  const deduplication = nonEmptyString(ownValue(attributes, 'MessageDeduplicationId'));
  const sequence = ownValue(attributes, 'SequenceNumber');
  if (
    count === undefined ||
    firstReceive === undefined ||
    sent === undefined ||
    group === undefined ||
    deduplication === undefined ||
    typeof sequence !== 'string' ||
    !SEQUENCE_NUMBER.test(sequence)
  ) {
    return err(
      `Attributes are ${quoted(attributes)}; expected ApproximateReceiveCount >= 1, ApproximateFirstReceiveTimestamp and SentTimestamp as epoch-millisecond digits, non-empty MessageGroupId and MessageDeduplicationId, and a digit SequenceNumber`,
    );
  }
  return ok({
    approximate_receive_count: count,
    approximate_first_receive_timestamp: firstReceive,
    sent_timestamp: sent,
    message_group_id: group,
    message_deduplication_id: deduplication,
    sequence_number: sequence,
  });
}

function malformed(target: QueueTarget, received: ReceivedSqsMessage, problem: string): StructuredReason {
  return {
    code: 'DLQ_MESSAGE_MALFORMED',
    subject: 'BR-RUA-037',
    detail: `dlq ${target.queue_name} returned message ${quoted(ownValue(received, 'MessageId'))}: ${problem}`,
  };
}
