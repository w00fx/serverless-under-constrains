// Assembles one journal event: a record-specific body under the BR-RUA-033 envelope
// (`schema_version`, `record_type`, `event_id`, execution identity and manifest digest, trial
// identity when the scope is a trial, `occurred_at`, `source`, `source_instance_id`,
// `source_sequence`, and `causation_event_ids` unless the event is a causal root).

import type { EventEnvelope, EventSource } from '../record-contract/envelope.ts';
import { causationIds, executionIdentityFields } from '../record-contract/envelope.ts';
import type { Uuid4, UtcMillis } from '../record-contract/primitives.ts';
import type { EventRecordType } from '../record-contract/record-types.ts';
import type { GroupBRecordByType } from '../record-contract/records/group-b/record-map.ts';
import type { JournalScope } from './journal-scope.ts';
import { isSourceSequence } from './journal-scope.ts';

/** Any journal event record (catalogue kind E, all in group B). */
export type JournalEvent = GroupBRecordByType[EventRecordType];

/** The envelope fields the writer owns; a body never sets them. */
export type EnvelopeField = keyof EventEnvelope<EventRecordType>;

// Distributes over union records (for example the three `request_state_recorded` shapes), which
// a plain `Omit` would collapse into one shape.
type BodyOf<R> = R extends unknown ? Omit<R, EnvelopeField> : never;

/** The record-specific fields of an event of type `T`. */
export type EventBody<T extends EventRecordType> = BodyOf<GroupBRecordByType[T]>;

/** Everything the envelope of one event needs besides the body. */
export interface EventEnvelopeInput {
  readonly scope: JournalScope;
  readonly source: EventSource;
  readonly source_instance_id: Uuid4;
  readonly source_sequence: number;
  readonly event_id: Uuid4;
  readonly occurred_at: UtcMillis;
  /** Immediate causal predecessors in any order; empty for a causal root. */
  readonly causation: readonly Uuid4[];
}

/**
 * Builds an event. The envelope is written after the body, so a body can never override an
 * envelope field. Causation is deduplicated and sorted, and omitted for a causal root.
 * Throws a RangeError for a `source_sequence` outside `1..MAX_SOURCE_SEQUENCE`.
 *
 * @example
 * buildJournalEvent('treatment_timeout_observed', body, { scope, source: 'refund_provider',
 *   source_instance_id, source_sequence: 4, event_id, occurred_at, causation: [signalEventId] });
 */
export function buildJournalEvent<T extends EventRecordType>(
  type: T,
  body: EventBody<T>,
  input: EventEnvelopeInput,
): JournalEvent {
  if (!isSourceSequence(input.source_sequence)) {
    throw new RangeError(
      `source_sequence ${String(input.source_sequence)} for ${type}; expected a positive integer of at most 12 digits`,
    );
  }
  const partition = input.scope.partition;
  const trialFields =
    partition.kind === 'trial'
      ? { trial_id: partition.trial_id, trial_manifest_sha256: partition.trial_manifest_sha256 }
      : {};
  const causation = causationIds(input.causation);
  const event = {
    ...body,
    schema_version: 1,
    record_type: type,
    event_id: input.event_id,
    ...executionIdentityFields(input.scope.execution),
    execution_manifest_sha256: input.scope.execution_manifest_sha256,
    ...trialFields,
    occurred_at: input.occurred_at,
    source: input.source,
    source_instance_id: input.source_instance_id,
    source_sequence: input.source_sequence,
    ...(causation === undefined ? {} : { causation_event_ids: causation }),
  };
  return event as unknown as JournalEvent;
}
