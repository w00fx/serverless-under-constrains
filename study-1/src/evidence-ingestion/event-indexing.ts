// Design §8.2 step I4 (BR-RUA-034): journal events are grouped by `event_id` over every origin. A
// copy structurally equal to the first is an ingestion duplicate, collapsed with a diagnostic
// count; a copy with other content is CONFLICTING_EVENT_CONTENT and makes evidence integrity
// invalid. The first copy read stays indexed either way, so later steps always see one event per
// id. Structural equality is the kernel's total `sameJsonValue`: member order and whitespace are
// ignored, array order and JSON types are not.

import { sameJsonValue } from '../record-contract/json-value.ts';
import { isEventRecordType, isRecordType } from '../record-contract/record-types.ts';
import type { JournalEvent } from '../event-journal/journal-event.ts';
import { ingestionFinding } from './ingestion-findings.ts';
import type { IndexedEvent, IngestedArtifact, IngestedRecord, IngestionFinding } from './ingestion-model.ts';
import { locateRecord } from './located-records.ts';
import { ownString, partitionOf } from './record-correlation.ts';

/** The events of every origin after duplicate collapse, with the conflicts found on the way. */
export interface EventCollapse {
  readonly by_id: ReadonlyMap<string, IndexedEvent>;
  readonly conflicting_event_ids: ReadonlySet<string>;
  readonly collapsed_duplicate_count: number;
  readonly findings: readonly IngestionFinding[];
}

interface EventGroup {
  readonly kept: IndexedEvent;
  readonly copies: IndexedEvent[];
  equivalent: number;
  conflicting: number;
}

/**
 * Indexes every event-typed record that is valid or only correlation-missing, collapsing
 * equivalent duplicates and flagging conflicts. Only groups that touch the subject or a
 * supplementary artifact produce findings; earlier trials are read for resolution only.
 *
 * @example
 * const collapse = indexEvents(artifacts);
 * collapse.by_id.get(eventId)?.copies; // 2 after one equivalent duplicate
 */
export function indexEvents(artifacts: readonly IngestedArtifact[]): EventCollapse {
  const groups = new Map<string, EventGroup>();
  for (const artifact of artifacts) {
    for (const event of artifactEvents(artifact)) {
      addToGroup(groups, event);
    }
  }
  const examined = [...groups.values()].filter((group) =>
    group.copies.some((copy) => copy.origin !== 'execution_scope'),
  );
  const conflicting = examined.filter((group) => group.conflicting > 0);
  return {
    by_id: new Map([...groups].map(([id, group]) => [id, { ...group.kept, copies: group.copies.length }])),
    conflicting_event_ids: new Set(conflicting.map((group) => group.kept.record.event_id)),
    collapsed_duplicate_count: examined.reduce((total, group) => total + group.equivalent, 0),
    findings: examined.flatMap(groupFindings),
  };
}

function artifactEvents(artifact: IngestedArtifact): readonly IndexedEvent[] {
  return artifact.records.flatMap((record) => (isIndexable(record) ? [indexedEvent(artifact, record)] : []));
}

// A schema-valid or correlation-missing record of an event type always has a UUIDv4 `event_id`:
// only correlation members may be absent from it.
function isIndexable(record: IngestedRecord): boolean {
  const recordType = ownString(record.value, 'record_type');
  return record.validity !== 'schema_invalid' && isRecordType(recordType) && isEventRecordType(recordType);
}

function indexedEvent(artifact: IngestedArtifact, record: IngestedRecord): IndexedEvent {
  return { ...locateRecord<JournalEvent>(artifact, record), partition: partitionOf(record.value), copies: 1 };
}

function addToGroup(groups: Map<string, EventGroup>, event: IndexedEvent): void {
  const group = groups.get(event.record.event_id);
  if (group === undefined) {
    groups.set(event.record.event_id, { kept: event, copies: [event], equivalent: 0, conflicting: 0 });
    return;
  }
  group.copies.push(event);
  if (sameJsonValue(group.kept.record, event.record)) {
    group.equivalent += 1;
  } else {
    group.conflicting += 1;
  }
}

function groupFindings(group: EventGroup): readonly IngestionFinding[] {
  const eventId = group.kept.record.event_id;
  const where = group.copies.map((copy) => locationOf(copy)).join(', ');
  const findings: IngestionFinding[] = [];
  if (group.conflicting > 0) {
    const detail = `expected one content per event_id; ${eventId} has ${String(group.copies.length)} copies that differ: ${where}`;
    findings.push(
      ingestionFinding('CONFLICTING_EVENT_CONTENT', detail, {
        artifact_path: group.kept.artifact_path,
        event_id: eventId,
        occurrences: group.conflicting,
      }),
    );
  }
  if (group.equivalent > 0) {
    const detail = `${eventId} read ${String(group.equivalent + 1)} times with structurally equivalent content, collapsed to one: ${where}`;
    findings.push(
      ingestionFinding('EQUIVALENT_DUPLICATE_COLLAPSED', detail, {
        artifact_path: group.kept.artifact_path,
        event_id: eventId,
        occurrences: group.equivalent,
      }),
    );
  }
  return findings;
}

function locationOf(event: IndexedEvent): string {
  return event.line_number === undefined ? event.artifact_path : `${event.artifact_path}:${String(event.line_number)}`;
}
