// Design §8.2 step I4 (BR-RUA-034): events grouped by event_id; a structurally equivalent copy
// (member order and whitespace ignored, array order and JSON types significant) is collapsed and
// counted; other content conflicts. Earlier trials are indexed for resolution, never judged.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { indexEvents } from '../../../src/evidence-ingestion/event-indexing.ts';
import type { IngestedArtifact, IngestedRecord } from '../../../src/evidence-ingestion/ingestion-model.ts';
import type { JsonValue, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { ingest, subjectOf, trialInput } from './support/evidence-fixtures.ts';
import { uuid } from './support/indexed-events.ts';

const EVENT = {
  record_type: 'dispatch_started',
  event_id: uuid(1),
  run_id: uuid(2),
  trial_id: uuid(3),
  causation_event_ids: [uuid(4), uuid(5)],
  source_sequence: 1,
};

function artifact(
  path: string,
  values: readonly JsonValue[],
  origin: IngestedArtifact['origin'] = 'subject',
): IngestedArtifact {
  const records: IngestedRecord[] = values.map((value, index) => ({
    artifact_path: path,
    line_number: index + 1,
    value,
    validity: 'valid',
  }));
  return { path, sha256: 'd'.repeat(64) as Sha256Hex, byte_length: 1, origin, parse_status: 'parsed', records };
}

describe('indexEvents', () => {
  it('collapses a copy that differs only in member order', () => {
    const reordered = Object.fromEntries(Object.entries(EVENT).toReversed()) as JsonValue;
    const collapse = indexEvents([artifact('a.jsonl', [EVENT]), artifact('b.jsonl', [reordered])]);
    assert.equal(collapse.collapsed_duplicate_count, 1);
    assert.equal(collapse.by_id.get(uuid(1))?.copies, 2);
    assert.equal(collapse.by_id.get(uuid(1))?.artifact_path, 'a.jsonl');
    assert.deepEqual(
      collapse.findings.map((finding) => [finding.code, finding.occurrences, finding.event_id]),
      [['EQUIVALENT_DUPLICATE_COLLAPSED', 1, uuid(1)]],
    );
    assert.match(
      collapse.findings[0]?.detail ?? '',
      /read 2 times with structurally equivalent content, collapsed to one: a\.jsonl:1, b\.jsonl:1$/u,
    );
  });

  it('locates a copy held in a JSON document by its path alone', () => {
    const document: IngestedArtifact = {
      ...artifact('extra/event.json', [EVENT], 'supplementary'),
      records: [{ artifact_path: 'extra/event.json', value: EVENT, validity: 'valid' }],
    };
    const collapse = indexEvents([artifact('a.jsonl', [EVENT]), document]);
    assert.match(collapse.findings[0]?.detail ?? '', /: a\.jsonl:1, extra\/event\.json$/u);
    assert.equal(collapse.by_id.get(uuid(1))?.line_number, 1);
  });

  it('flags content that differs in array order or JSON type, keeping the first copy', () => {
    for (const changed of [
      { ...EVENT, causation_event_ids: [uuid(5), uuid(4)] },
      { ...EVENT, source_sequence: '1' },
    ]) {
      const collapse = indexEvents([artifact('a.jsonl', [EVENT, changed])]);
      assert.deepEqual([...collapse.conflicting_event_ids], [uuid(1)]);
      assert.equal(collapse.by_id.get(uuid(1))?.record.source_sequence, 1);
      assert.deepEqual(
        collapse.findings.map((finding) => finding.code),
        ['CONFLICTING_EVENT_CONTENT'],
      );
      assert.equal(collapse.collapsed_duplicate_count, 0);
    }
  });

  it('reports both an equivalent and a conflicting copy of one event', () => {
    const collapse = indexEvents([artifact('a.jsonl', [EVENT, EVENT, { ...EVENT, run_id: uuid(9) }])]);
    assert.deepEqual(
      collapse.findings.map((finding) => finding.code),
      ['CONFLICTING_EVENT_CONTENT', 'EQUIVALENT_DUPLICATE_COLLAPSED'],
    );
    assert.match(
      collapse.findings[0]?.detail ?? '',
      /^expected one content per event_id; .* has 3 copies that differ: a\.jsonl:1, a\.jsonl:2, a\.jsonl:3$/u,
    );
  });

  it('keeps the subject copy whatever order the artifacts are listed in (review WP-12 R2)', () => {
    const changed = { ...EVENT, run_id: uuid(9) };
    const collapse = indexEvents([
      artifact('z.jsonl', [changed], 'execution_scope'),
      artifact('y.jsonl', [changed], 'supplementary'),
      artifact('a.jsonl', [EVENT]),
    ]);
    const kept = collapse.by_id.get(uuid(1));
    assert.equal(kept?.artifact_path, 'a.jsonl');
    assert.equal(kept.origin, 'subject');
    assert.deepEqual(kept.record, EVENT);
    assert.deepEqual(
      collapse.findings.map((finding) => [finding.code, finding.artifact_path]),
      [['CONFLICTING_EVENT_CONTENT', 'a.jsonl']],
    );
    assert.match(collapse.findings[0]?.detail ?? '', /differ: a\.jsonl:1, y\.jsonl:1, z\.jsonl:1$/u);
  });

  it('indexes copies found only in earlier trials without judging them', () => {
    const collapse = indexEvents([
      artifact('a.jsonl', [EVENT], 'execution_scope'),
      artifact('b.jsonl', [{ ...EVENT, run_id: uuid(9) }], 'execution_scope'),
    ]);
    assert.deepEqual(collapse.findings, []);
    assert.equal(collapse.conflicting_event_ids.size, 0);
    assert.equal(collapse.by_id.size, 1);
  });

  it('indexes only schema-usable event records, flagging correlation-missing ones', () => {
    const base = artifact('a.jsonl', [
      EVENT,
      { ...EVENT, event_id: uuid(6) },
      { record_type: 'payment', event_id: uuid(7) },
      { event_id: uuid(8) },
    ]);
    const records: IngestedRecord[] = base.records.map((record, index) => ({
      ...record,
      validity: index === 0 ? 'schema_invalid' : index === 1 ? 'correlation_missing' : 'valid',
    }));
    const collapse = indexEvents([{ ...base, records }]);
    assert.deepEqual([...collapse.by_id.keys()], [uuid(6)]);
    const indexed = collapse.by_id.get(uuid(6));
    assert.equal(indexed?.correlation_missing, true);
    assert.equal(indexed.partition, uuid(3));
    assert.equal(indexed.line_number, 2);
  });

  it('collapses the duplicate a trial journal repeats and counts it in the diagnostics', () => {
    const evidence = ingest(
      trialInput('run-conventional-control', [
        { op: 'clone_record', path: '$trial/journals/caller-journal.jsonl', select: { line: 1 }, set: [] },
      ]),
    );
    assert.equal(evidence.diagnostics.collapsed_duplicate_count, 1);
    assert.equal(evidence.events.subject.length, ingest(trialInput()).events.subject.length);
    assert.ok(evidence.events.subject.every((event) => event.origin === 'subject'));
    assert.ok(evidence.events.subject.some((event) => event.artifact_path.startsWith(subjectOf(trialInput()))));
  });
});
