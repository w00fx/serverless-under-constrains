// Queue counter observations (design §5.3 `QueueCounterReader`, §7 `queues/`, §8.12; BR-RUA-032).
// SQS reports approximate counters as attribute strings (`ApproximateNumberOfMessages`,
// `ApproximateNumberOfMessagesNotVisible`, `ApproximateNumberOfMessagesDelayed`); they lag by at
// least 60 s and never establish settlement alone (RK-14). A failed read is recorded as
// `unavailable` with its error code, which settlement never treats as quiet.

import { err, ok } from '../record-contract/primitives.ts';
import type { JsonObject, Result, WallClock } from '../record-contract/primitives.ts';
import type { QueueCounters } from '../record-contract/records/group-b/shared-shapes.ts';
import type { QueueRole } from '../record-contract/records/group-b/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { correlationFields } from './capture-scope.ts';
import type { TrialCaptureScope } from './capture-scope.ts';
import type { CollectorReadFailure } from './collected-records.ts';
import { digitCount, ownValue, quoted } from './sdk-values.ts';

/** One counter read of a queue (design §5.3). */
export interface QueueCounterReader {
  read(queueUrl: string): Promise<Result<QueueCounters, CollectorReadFailure>>;
}

/** A queue the collector observes: its URL for reads and its name for the record. */
export interface QueueTarget {
  readonly queue_url: string;
  readonly queue_name: string;
}

/** The SQS attribute names that hold the three counters (GetQueueAttributes). */
export const QUEUE_COUNTER_ATTRIBUTES = {
  visible: 'ApproximateNumberOfMessages',
  in_flight: 'ApproximateNumberOfMessagesNotVisible',
  delayed: 'ApproximateNumberOfMessagesDelayed',
} as const;

/** One observation: the `queue_observation` record and the counters a settlement sample reads. */
export interface QueueObservation {
  readonly record: JsonObject;
  /** The counters read, or `unavailable` when the read failed (never quiet, BR-RUA-032). */
  readonly counters: QueueCounters | 'unavailable';
}

/**
 * Parses the three counters from a GetQueueAttributes attribute map. Total over untrusted input:
 * only own members are read, and each must be a canonical decimal string within the safe
 * integers.
 *
 * @example
 * parseQueueCounterAttributes({ ApproximateNumberOfMessages: '1', ApproximateNumberOfMessagesNotVisible: '0', ApproximateNumberOfMessagesDelayed: '0' });
 * // { ok: true, value: { visible: 1, in_flight: 0, delayed: 0 } }
 */
export function parseQueueCounterAttributes(
  attributes: Readonly<Record<string, string | undefined>> | undefined,
): Result<QueueCounters, string> {
  const visible = counterOf(attributes, QUEUE_COUNTER_ATTRIBUTES.visible);
  if (!visible.ok) {
    return visible;
  }
  const inFlight = counterOf(attributes, QUEUE_COUNTER_ATTRIBUTES.in_flight);
  if (!inFlight.ok) {
    return inFlight;
  }
  const delayed = counterOf(attributes, QUEUE_COUNTER_ATTRIBUTES.delayed);
  if (!delayed.ok) {
    return delayed;
  }
  return ok({ visible: visible.value, in_flight: inFlight.value, delayed: delayed.value });
}

/**
 * Reads a queue's counters into a `queue_observation` record (catalogue row 57) for a trial; a
 * failed read is recorded as `unavailable` with its error code.
 *
 * @example
 * const observation = await observeQueue(reader, source, 'source', scope, clock);
 * observation.record['read_status']; // 'ok' or 'unavailable'
 */
export async function observeQueue(
  reader: QueueCounterReader,
  target: QueueTarget,
  role: QueueRole,
  scope: TrialCaptureScope,
  clock: WallClock,
): Promise<QueueObservation> {
  const read = await reader.read(target.queue_url);
  const base = {
    schema_version: 1,
    record_type: 'queue_observation',
    ...correlationFields(scope),
    queue_role: role,
    queue_name: target.queue_name,
    observed_at: formatUtcMillis(clock.now()),
  };
  if (!read.ok) {
    return { record: { ...base, read_status: 'unavailable', error_code: read.error.code }, counters: 'unavailable' };
  }
  const counters = read.value;
  return { record: { ...base, read_status: 'ok', counters: countersJson(counters) }, counters };
}

/**
 * Queue counters as the JSON object a record carries.
 *
 * @example
 * countersJson({ visible: 0, in_flight: 1, delayed: 0 }); // { visible: 0, in_flight: 1, delayed: 0 }
 */
export function countersJson(counters: QueueCounters): JsonObject {
  return { visible: counters.visible, in_flight: counters.in_flight, delayed: counters.delayed };
}

function counterOf(
  attributes: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): Result<number, string> {
  const raw = ownValue(attributes, name);
  const count = digitCount(raw, 0);
  if (count === undefined) {
    return err(`queue attribute ${name} is ${quoted(raw)}; expected a non-negative decimal integer string`);
  }
  return ok(count);
}
