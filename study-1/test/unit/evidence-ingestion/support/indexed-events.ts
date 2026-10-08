// Hand-built indexed events for the pure density, causation and identity checks: only the members
// those checks read are meaningful; the rest are well-formed placeholders.

import type { JournalEvent } from '../../../../src/event-journal/journal-event.ts';
import type { ArtifactOrigin, IndexedEvent } from '../../../../src/evidence-ingestion/ingestion-model.ts';
import type { Sha256Hex } from '../../../../src/record-contract/primitives.ts';

export interface EventShape {
  readonly event_id: string;
  readonly record_type?: string;
  readonly source?: string;
  readonly source_instance_id?: string;
  readonly source_sequence?: number;
  readonly causation_event_ids?: readonly string[];
  readonly origin?: ArtifactOrigin;
  readonly partition?: string;
  readonly artifact_path?: string;
  readonly members?: Readonly<Record<string, string>>;
}

/** A well-formed instance id for events that share one source instance. */
export const INSTANCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const DIGEST = 'c'.repeat(64) as Sha256Hex;

/**
 * An indexed event with the given identity, sequence and origin.
 *
 * @example
 * indexedEvent({ event_id: uuid(1), source_sequence: 1 });
 */
export function indexedEvent(shape: EventShape): IndexedEvent {
  const record = {
    record_type: shape.record_type ?? 'dispatch_started',
    event_id: shape.event_id,
    source: shape.source ?? 'conventional_caller',
    source_instance_id: shape.source_instance_id ?? INSTANCE,
    source_sequence: shape.source_sequence ?? 1,
    ...(shape.causation_event_ids === undefined ? {} : { causation_event_ids: shape.causation_event_ids }),
    ...(shape.partition === undefined || shape.partition === 'execution' ? {} : { trial_id: shape.partition }),
    ...shape.members,
  };
  return {
    record: record as unknown as JournalEvent,
    artifact_path: shape.artifact_path ?? 'trials/t/journals/caller-journal.jsonl',
    artifact_sha256: DIGEST,
    line_number: shape.source_sequence ?? 1,
    origin: shape.origin ?? 'subject',
    correlation_missing: false,
    partition: shape.partition ?? 'execution',
    copies: 1,
  };
}

/**
 * The nth well-formed UUIDv4 of a test (1 to 4095).
 *
 * @example
 * uuid(1); // '00000000-0000-4000-8000-000000000001'
 */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}
