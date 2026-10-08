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
import { assertSourceSequence } from './journal-scope.ts';

/** Any journal event record (catalogue kind E, all in group B). */
export type JournalEvent = GroupBRecordByType[EventRecordType];

/** The envelope fields the writer owns; a body never sets them. */
export type EnvelopeField = keyof EventEnvelope<EventRecordType>;

// Distributes over union records (for example the three `request_state_recorded` shapes), which
// a plain `Omit` would collapse into one shape.
type BodyOf<R> = R extends unknown ? Omit<R, EnvelopeField> : never;

/** The record-specific fields of an event of type `T`. */
export type EventBody<T extends EventRecordType> = BodyOf<GroupBRecordByType[T]>;

// Every envelope field, as a runtime list. The mapped type makes a missing or misspelled field
// a compile error, so this list cannot drift from `EventEnvelope`.
const ENVELOPE_FIELD_NAMES: { readonly [K in EnvelopeField]: K } = {
  schema_version: 'schema_version',
  record_type: 'record_type',
  event_id: 'event_id',
  run_id: 'run_id',
  variant_validation_id: 'variant_validation_id',
  transport_probe_id: 'transport_probe_id',
  execution_manifest_sha256: 'execution_manifest_sha256',
  trial_id: 'trial_id',
  trial_manifest_sha256: 'trial_manifest_sha256',
  occurred_at: 'occurred_at',
  source: 'source',
  source_instance_id: 'source_instance_id',
  source_sequence: 'source_sequence',
  causation_event_ids: 'causation_event_ids',
};
const ENVELOPE_FIELDS: ReadonlySet<string> = new Set<string>(Object.values(ENVELOPE_FIELD_NAMES));

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
 * Builds an event. The builder owns every envelope field (BR-RUA-033): an envelope key that
 * reaches the body at runtime (the compile-time `Omit` does not see through object spreads) is
 * dropped, so a body can neither override an envelope field nor add one the scope leaves unset,
 * such as a second execution identity, trial fields outside a trial partition or causation on a
 * causal root (WP-05 review round 2). Causation is deduplicated and sorted, and omitted for a causal root.
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
  assertSourceSequence(input.source_sequence, type);
  const partition = input.scope.partition;
  const trialFields =
    partition.kind === 'trial'
      ? { trial_id: partition.trial_id, trial_manifest_sha256: partition.trial_manifest_sha256 }
      : {};
  const causation = causationIds(input.causation);
  const event = {
    ...recordSpecificFields(body),
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
  // The one cast of the builder: TypeScript cannot relate a spread of the generic body
  // `EventBody<T>` back to the union member it came from. Its soundness is checked at runtime
  // for every event record type (test/integration/event-journal/journal-builder-catalogue).
  return event as unknown as JournalEvent;
}

// The body without any envelope key. `Object.entries` reads own enumerable properties only, the
// same ones a spread copies.
function recordSpecificFields(body: object): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(body).filter(([name]) => !ENVELOPE_FIELDS.has(name)));
}
