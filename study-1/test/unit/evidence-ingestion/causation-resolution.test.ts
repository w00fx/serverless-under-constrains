// Design §8.2 step I6 (BR-RUA-033, BR-RUA-034; AC-RUA-041 case 3): every causal predecessor of a
// subject or supplementary event resolves inside the execution scope.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveCausation } from '../../../src/evidence-ingestion/causation-resolution.ts';
import type { IndexedEvent } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { indexedEvent, uuid } from './support/indexed-events.ts';

function indexOf(events: readonly IndexedEvent[]): ReadonlyMap<string, IndexedEvent> {
  return new Map(events.map((event) => [event.record.event_id, event]));
}

describe('resolveCausation', () => {
  it('resolves predecessors in the subject and in earlier trials', () => {
    const events = [
      indexedEvent({ event_id: uuid(1), origin: 'execution_scope' }),
      indexedEvent({ event_id: uuid(2) }),
      indexedEvent({ event_id: uuid(3), causation_event_ids: [uuid(1), uuid(2)] }),
    ];
    const causation = resolveCausation(indexOf(events));
    assert.deepEqual(causation.findings, []);
    assert.equal(causation.unresolved.size, 0);
  });

  it('reports each dependent event with its absent predecessors', () => {
    const events = [
      indexedEvent({ event_id: uuid(1) }),
      indexedEvent({
        event_id: uuid(2),
        causation_event_ids: [uuid(1), uuid(7), uuid(8)],
        origin: 'supplementary',
        artifact_path: 'provider/provider-journal.jsonl',
      }),
    ];
    const causation = resolveCausation(indexOf(events));
    assert.deepEqual([...causation.unresolved], [[uuid(2), [uuid(7), uuid(8)]]]);
    assert.deepEqual(causation.findings, [
      {
        code: 'CAUSAL_PREDECESSOR_MISSING',
        subject: 'BR-RUA-034',
        artifact_path: 'provider/provider-journal.jsonl',
        event_id: uuid(2),
        detail: `expected every causal predecessor in the execution scope; dispatch_started ${uuid(2)} names absent ${uuid(7)}, ${uuid(8)}`,
        occurrences: 2,
      },
    ]);
  });

  it('does not judge earlier trials', () => {
    const events = [indexedEvent({ event_id: uuid(2), causation_event_ids: [uuid(9)], origin: 'execution_scope' })];
    assert.deepEqual(resolveCausation(indexOf(events)).findings, []);
  });
});
