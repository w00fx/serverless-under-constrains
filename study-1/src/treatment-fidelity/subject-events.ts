// Typed access to the journal events of the evaluated trial or probe partition (design §8.10).
// Ingestion has already proved each event's shape against its schema, so an event selected by its
// `record_type` is that record type; the narrowing here is the only cast the conditions rely on.
// Only subject events count: the A-09 execution-level `<execution_id>#provider` partition is
// supplementary evidence and never verdict-critical.

import type { IndexedEvent, IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import { EXECUTION_PARTITION, ownString } from '../evidence-ingestion/record-correlation.ts';
import type { JsonValue } from '../record-contract/primitives.ts';
import type { EventRecordType } from '../record-contract/record-types.ts';
import type { GroupBRecordByType } from '../record-contract/records/group-b/record-map.ts';
import { CALLER_EVENT_SOURCES } from '../record-contract/records/group-b/vocabulary.ts';

/** An indexed event whose record is of type `T`. */
export type EventOf<T extends EventRecordType> = IndexedEvent & { readonly record: GroupBRecordByType[T] };

const CALLER_SOURCES: ReadonlySet<string> = new Set<string>(CALLER_EVENT_SOURCES);

/**
 * The partition of the evaluated subject: the trial id, or `execution` for the probe (D-06).
 *
 * @example
 * subjectPartition(probeEvidence); // 'execution'
 */
export function subjectPartition(evidence: IngestedEvidence): string {
  return evidence.scope.trial?.trial_id ?? EXECUTION_PARTITION;
}

/**
 * The subject events of the evaluated partition, in artifact and line order.
 *
 * @example
 * partitionEvents(evidence).length; // every caller, provider, controller and runner event of the trial
 */
export function partitionEvents(evidence: IngestedEvidence): readonly IndexedEvent[] {
  const partition = subjectPartition(evidence);
  return evidence.events.subject.filter((event) => event.partition === partition);
}

/**
 * The events of one record type.
 *
 * @example
 * eventsOfType(events, 'caller_timeout_recorded')[0]?.record.timer_fired_at;
 */
export function eventsOfType<T extends EventRecordType>(
  events: readonly IndexedEvent[],
  type: T,
): readonly EventOf<T>[] {
  return events.filter((event): event is EventOf<T> => event.record.record_type === type);
}

/**
 * An own string member of an event, read as untrusted JSON (A-05: inherited names never count).
 *
 * @example
 * eventString(event, 'provider_transaction_id'); // undefined when the event has none
 */
export function eventString(event: IndexedEvent, field: string): string | undefined {
  return ownString(event.record as unknown as JsonValue, field);
}

/**
 * Whether an event was written by a caller (conventional, Durable or probe).
 *
 * @example
 * isCallerEvent(dispatchStarted); // true
 */
export function isCallerEvent(event: IndexedEvent): boolean {
  return CALLER_SOURCES.has(event.record.source);
}

/**
 * Whether `later` names `earlier` among its immediate causal predecessors.
 *
 * @example
 * causedBy(release, observation); // true when the release names the observation
 */
export function causedBy(later: IndexedEvent, earlier: IndexedEvent): boolean {
  return (later.record.causation_event_ids ?? []).includes(earlier.record.event_id);
}
