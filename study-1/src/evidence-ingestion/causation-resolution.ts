// Design §8.2 step I6 (BR-RUA-033, BR-RUA-034): every `causation_event_ids` entry of a subject or
// supplementary event must resolve to an indexed event of the execution scope (this trial, the
// execution-level journals and earlier trials). An unresolved predecessor is
// CAUSAL_PREDECESSOR_MISSING: the checks relying on the dependent event are indeterminate and, on
// a verdict-critical record, traceability is unverified (AC-RUA-041 case 3).

import { ingestionFinding } from './ingestion-findings.ts';
import type { IndexedEvent, IngestionFinding } from './ingestion-model.ts';

export interface CausationResolution {
  /** Dependent event id to the predecessor ids that did not resolve. */
  readonly unresolved: ReadonlyMap<string, readonly string[]>;
  readonly findings: readonly IngestionFinding[];
}

/**
 * Resolves the causal predecessors of every subject and supplementary event against the index.
 *
 * @example
 * const causation = resolveCausation(collapse.by_id);
 * causation.unresolved.get(dependentId); // ['<missing predecessor id>']
 */
export function resolveCausation(byId: ReadonlyMap<string, IndexedEvent>): CausationResolution {
  const unresolved = new Map<string, readonly string[]>();
  const findings: IngestionFinding[] = [];
  for (const event of [...byId.values()].filter((candidate) => candidate.origin !== 'execution_scope')) {
    const missing = predecessorsOf(event).filter((id) => !byId.has(id));
    if (missing.length === 0) {
      continue;
    }
    unresolved.set(event.record.event_id, missing);
    const detail = `expected every causal predecessor in the execution scope; ${event.record.record_type} ${event.record.event_id} names absent ${missing.join(', ')}`;
    findings.push(
      ingestionFinding('CAUSAL_PREDECESSOR_MISSING', detail, {
        artifact_path: event.artifact_path,
        event_id: event.record.event_id,
        occurrences: missing.length,
      }),
    );
  }
  return { unresolved, findings };
}

// The schema makes `causation_event_ids` a sorted, unique, non-empty UUIDv4 list when present,
// so an indexed event's list is read as is.
function predecessorsOf(event: IndexedEvent): readonly string[] {
  return event.record.causation_event_ids ?? [];
}
