// Design §8.2 step I5 (BR-RUA-033, BR-RUA-034): sequences are dense from 1 per source instance;
// two event ids at one sequence conflict; a gap makes the instance gapped. Only subject and
// supplementary instances are judged, and a gap is counted, never enumerated.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkSequenceDensity, instanceKey } from '../../../src/evidence-ingestion/sequence-density.ts';
import { INSTANCE, indexedEvent, uuid } from './support/indexed-events.ts';

const KEY = `conventional_caller#${INSTANCE}`;

describe('checkSequenceDensity', () => {
  it('finds a dense instance ungapped', () => {
    const density = checkSequenceDensity([1, 2, 3].map((n) => indexedEvent({ event_id: uuid(n), source_sequence: n })));
    assert.deepEqual(density.findings, []);
    assert.deepEqual(density.instances.get(KEY), {
      key: KEY,
      source: 'conventional_caller',
      source_instance_id: INSTANCE,
      max_sequence: 3,
      missing_sequences: 0,
      conflicting_sequences: 0,
      gapped: false,
    });
  });

  it('counts a gap and names the first absent sequence', () => {
    const events = [1, 2, 5, 7].map((n) => indexedEvent({ event_id: uuid(n), source_sequence: n }));
    const density = checkSequenceDensity(events);
    assert.equal(density.instances.get(KEY)?.missing_sequences, 3);
    assert.equal(density.instances.get(KEY)?.gapped, true);
    assert.deepEqual(density.findings, [
      {
        code: 'SOURCE_SEQUENCE_GAP',
        subject: 'BR-RUA-034',
        artifact_path: 'trials/t/journals/caller-journal.jsonl',
        source_instance_key: KEY,
        detail: `expected dense sequences 1..7; ${KEY} lacks 3, first 3`,
        occurrences: 3,
      },
    ]);
  });

  it('finds an instance that does not start at 1 gapped', () => {
    const density = checkSequenceDensity([indexedEvent({ event_id: uuid(1), source_sequence: 2 })]);
    assert.match(density.findings[0]?.detail ?? '', /lacks 1, first 1$/u);
  });

  it('handles the largest safe sequence without enumerating the gap', () => {
    const density = checkSequenceDensity([
      indexedEvent({ event_id: uuid(1), source_sequence: 1 }),
      indexedEvent({ event_id: uuid(2), source_sequence: Number.MAX_SAFE_INTEGER }),
    ]);
    assert.equal(density.instances.get(KEY)?.missing_sequences, Number.MAX_SAFE_INTEGER - 2);
    assert.match(density.findings[0]?.detail ?? '', /first 2$/u);
  });

  it('reports two event ids at one sequence once per instance', () => {
    const events = [
      indexedEvent({ event_id: uuid(1), source_sequence: 1 }),
      indexedEvent({ event_id: uuid(2), source_sequence: 1 }),
      indexedEvent({ event_id: uuid(3), source_sequence: 2 }),
      indexedEvent({ event_id: uuid(4), source_sequence: 2 }),
    ];
    const density = checkSequenceDensity(events);
    assert.equal(density.instances.get(KEY)?.conflicting_sequences, 2);
    assert.deepEqual(
      density.findings.map((finding) => [finding.code, finding.occurrences, finding.detail]),
      [
        [
          'CONFLICTING_SOURCE_SEQUENCE',
          2,
          `expected one event_id per sequence; ${KEY} sequence 1 has ${uuid(1)}, ${uuid(2)}`,
        ],
      ],
    );
  });

  it('judges instances apart and ignores earlier trials', () => {
    const density = checkSequenceDensity([
      indexedEvent({ event_id: uuid(1), source_sequence: 1 }),
      indexedEvent({ event_id: uuid(2), source_sequence: 1, source: 'refund_provider' }),
      indexedEvent({ event_id: uuid(3), source_sequence: 9, source_instance_id: uuid(99), origin: 'execution_scope' }),
      indexedEvent({ event_id: uuid(4), source_sequence: 1, source_instance_id: uuid(98), origin: 'supplementary' }),
    ]);
    assert.deepEqual(density.findings, []);
    assert.equal(density.instances.size, 3);
  });
});

describe('instanceKey', () => {
  it('joins source and instance id', () => {
    assert.equal(instanceKey(indexedEvent({ event_id: uuid(1), source: 'runner' })), `runner#${INSTANCE}`);
  });
});
