// Design §8.2 step I5 (BR-RUA-033, BR-RUA-034): within one `(source, source_instance_id)` the
// `source_sequence` values are dense from 1. Two event ids at one sequence are
// CONFLICTING_SOURCE_SEQUENCE (evidence integrity invalid); an absent sequence below the highest
// one read is SOURCE_SEQUENCE_GAP, and the instance is *gapped*: every check relying on it is
// indeterminate. Only the subject's and supplementary instances are judged; earlier trials are
// context. A sequence may be as large as 2^53 - 1, so gaps are counted, never enumerated.

import { ingestionFinding } from './ingestion-findings.ts';
import type { IndexedEvent, IngestionFinding, SourceInstanceView } from './ingestion-model.ts';

export interface SequenceDensity {
  readonly instances: ReadonlyMap<string, SourceInstanceView>;
  readonly findings: readonly IngestionFinding[];
}

interface InstanceEvents {
  readonly first: IndexedEvent;
  readonly by_sequence: Map<number, string[]>;
}

/**
 * Judges the density of every subject and supplementary source instance.
 *
 * @example
 * const density = checkSequenceDensity([...collapse.by_id.values()]);
 * density.instances.get('conventional_caller#<uuid>')?.gapped;
 */
export function checkSequenceDensity(events: readonly IndexedEvent[]): SequenceDensity {
  const grouped = new Map<string, InstanceEvents>();
  for (const event of events.filter((candidate) => candidate.origin !== 'execution_scope')) {
    const key = instanceKey(event);
    const instance = grouped.get(key) ?? { first: event, by_sequence: new Map<number, string[]>() };
    grouped.set(key, instance);
    const ids = instance.by_sequence.get(event.record.source_sequence) ?? [];
    ids.push(event.record.event_id);
    instance.by_sequence.set(event.record.source_sequence, ids);
  }
  const judged = [...grouped].map(([key, instance]) => judgeInstance(key, instance));
  return {
    instances: new Map(judged.map((entry) => [entry.view.key, entry.view])),
    findings: judged.flatMap((entry) => entry.findings),
  };
}

/**
 * The `<source>#<source_instance_id>` key of an event's instance.
 *
 * @example
 * instanceKey(event); // 'refund_provider#4f6c...'
 */
export function instanceKey(event: IndexedEvent): string {
  return `${event.record.source}#${event.record.source_instance_id}`;
}

function judgeInstance(
  key: string,
  instance: InstanceEvents,
): { readonly view: SourceInstanceView; readonly findings: readonly IngestionFinding[] } {
  const sequences = [...instance.by_sequence.keys()].toSorted((a, b) => a - b);
  const maxSequence = sequences.reduce((highest, sequence) => Math.max(highest, sequence), 0);
  const missing = maxSequence - sequences.length;
  const conflicts = [...instance.by_sequence].filter(([, ids]) => ids.length > 1);
  const view: SourceInstanceView = {
    key,
    source: instance.first.record.source,
    source_instance_id: instance.first.record.source_instance_id,
    max_sequence: maxSequence,
    missing_sequences: missing,
    conflicting_sequences: conflicts.length,
    gapped: missing > 0,
  };
  const location = { artifact_path: instance.first.artifact_path, source_instance_key: key };
  const findings: IngestionFinding[] = [];
  const [firstConflict] = conflicts;
  if (firstConflict !== undefined) {
    const [sequence, ids] = firstConflict;
    const detail = `expected one event_id per sequence; ${key} sequence ${String(sequence)} has ${ids.join(', ')}`;
    findings.push(
      ingestionFinding('CONFLICTING_SOURCE_SEQUENCE', detail, { ...location, occurrences: conflicts.length }),
    );
  }
  if (missing > 0) {
    const detail = `expected dense sequences 1..${String(maxSequence)}; ${key} lacks ${String(missing)}, first ${String(firstMissing(sequences))}`;
    findings.push(ingestionFinding('SOURCE_SEQUENCE_GAP', detail, { ...location, occurrences: missing }));
  }
  return { view, findings };
}

// `sequences` is sorted, distinct and positive, and some value below its maximum is absent, so
// the first position whose value is not its 1-based index names the first absent sequence.
function firstMissing(sequences: readonly number[]): number {
  const position = sequences.findIndex((sequence, index) => sequence !== index + 1);
  return position + 1;
}
