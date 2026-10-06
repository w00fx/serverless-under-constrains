// BR-RUA-034 findings (design §8.2): each names its spec rule, keeps only a well-formed location,
// bounds its detail, sorts deterministically and merges per artifact and source instance so the
// finding count does not scale with the evidence (Owner amendment A-12).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aggregatedDetail,
  findingReason,
  ingestionFinding,
  mergeFindings,
  sortFindings,
} from '../../../src/evidence-ingestion/ingestion-findings.ts';

const EVENT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('ingestionFinding', () => {
  it('names the spec rule of its code and keeps a valid location', () => {
    const finding = ingestionFinding('SOURCE_SEQUENCE_GAP', 'gap', {
      artifact_path: 'trials/t/journals/caller-journal.jsonl',
      event_id: EVENT_ID,
      source_instance_key: 'conventional_caller#x',
      occurrences: 3,
    });
    assert.deepEqual(finding, {
      code: 'SOURCE_SEQUENCE_GAP',
      subject: 'BR-RUA-034',
      artifact_path: 'trials/t/journals/caller-journal.jsonl',
      event_id: EVENT_ID,
      source_instance_key: 'conventional_caller#x',
      detail: 'gap',
      occurrences: 3,
    });
  });

  it('maps every code family to its rule', () => {
    assert.equal(ingestionFinding('ARTIFACT_MISSING', 'd').subject, 'BR-RUA-037');
    assert.equal(ingestionFinding('ARTIFACT_UNPARSEABLE', 'd').subject, 'BR-RUA-033');
    assert.equal(ingestionFinding('RECORD_SCHEMA_INVALID', 'd').subject, 'BR-RUA-033');
    assert.equal(ingestionFinding('CORRELATION_MISSING', 'd').subject, 'BR-RUA-008');
  });

  it('drops an empty, absolute or traversing path and a non-UUIDv4 event id, and counts one occurrence', () => {
    for (const artifact_path of ['', '/etc/passwd', '../x.json']) {
      const finding = ingestionFinding('ARTIFACT_UNPARSEABLE', 'd', { artifact_path, event_id: 'not-a-uuid' });
      assert.equal(finding.artifact_path, undefined);
      assert.equal(finding.event_id, undefined);
      assert.equal(finding.occurrences, 1);
      assert.equal(Object.hasOwn(finding, 'source_instance_key'), false);
    }
  });

  it('bounds a long detail', () => {
    const finding = ingestionFinding('ARTIFACT_UNPARSEABLE', 'x'.repeat(5_000));
    assert.equal(finding.detail, `${'x'.repeat(200)}…[truncated]`);
  });
});

describe('findingReason', () => {
  it('keeps the structured reason members only', () => {
    const finding = ingestionFinding('SOURCE_SEQUENCE_GAP', 'd', {
      artifact_path: 'a.jsonl',
      event_id: EVENT_ID,
      source_instance_key: 'k',
      occurrences: 2,
    });
    assert.deepEqual(findingReason(finding), {
      code: 'SOURCE_SEQUENCE_GAP',
      subject: 'BR-RUA-034',
      artifact_path: 'a.jsonl',
      event_id: EVENT_ID,
      detail: 'd',
    });
  });

  it('leaves absent locations absent', () => {
    assert.deepEqual(findingReason(ingestionFinding('ARTIFACT_MISSING', 'd')), {
      code: 'ARTIFACT_MISSING',
      subject: 'BR-RUA-037',
      detail: 'd',
    });
  });
});

describe('sortFindings', () => {
  it('orders by code, artifact, source instance, event and detail', () => {
    const findings = [
      ingestionFinding('SOURCE_SEQUENCE_GAP', 'b', { artifact_path: 'b.jsonl' }),
      ingestionFinding('SOURCE_SEQUENCE_GAP', 'a', { artifact_path: 'b.jsonl' }),
      ingestionFinding('SOURCE_SEQUENCE_GAP', 'z', { artifact_path: 'b.jsonl', source_instance_key: 'k' }),
      ingestionFinding('SOURCE_SEQUENCE_GAP', 'z', {
        artifact_path: 'b.jsonl',
        source_instance_key: 'k',
        event_id: EVENT_ID,
      }),
      ingestionFinding('SOURCE_SEQUENCE_GAP', 'z', { artifact_path: 'a.jsonl' }),
      ingestionFinding('ARTIFACT_MISSING', 'z'),
    ];
    assert.deepEqual(
      sortFindings(findings).map((finding) => [
        finding.code,
        finding.artifact_path,
        finding.source_instance_key,
        finding.event_id,
        finding.detail,
      ]),
      [
        ['ARTIFACT_MISSING', undefined, undefined, undefined, 'z'],
        ['SOURCE_SEQUENCE_GAP', 'a.jsonl', undefined, undefined, 'z'],
        ['SOURCE_SEQUENCE_GAP', 'b.jsonl', undefined, undefined, 'a'],
        ['SOURCE_SEQUENCE_GAP', 'b.jsonl', undefined, undefined, 'b'],
        ['SOURCE_SEQUENCE_GAP', 'b.jsonl', 'k', undefined, 'z'],
        ['SOURCE_SEQUENCE_GAP', 'b.jsonl', 'k', EVENT_ID, 'z'],
      ],
    );
  });

  it('keeps equal findings', () => {
    const finding = ingestionFinding('ARTIFACT_MISSING', 'd');
    assert.deepEqual(sortFindings([finding, { ...finding }]), [finding, finding]);
  });
});

describe('aggregatedDetail', () => {
  it('says how many more occurrences the first stands for', () => {
    assert.equal(aggregatedDetail('line 4: bad', 1), 'line 4: bad');
    assert.equal(aggregatedDetail('line 4: bad', 3), 'line 4: bad (and 2 more)');
  });

  it('cuts the first occurrence shorter than a whole detail so the count survives', () => {
    const detail = aggregatedDetail('y'.repeat(400), 2);
    assert.equal(detail, `${'y'.repeat(150)}…[truncated] (and 1 more)`);
    assert.ok(ingestionFinding('ARTIFACT_UNPARSEABLE', detail).detail.endsWith('(and 1 more)'));
  });
});

describe('mergeFindings', () => {
  it('merges one code on one artifact and instance, summing occurrences', () => {
    const first = ingestionFinding('CAUSAL_PREDECESSOR_MISSING', 'first', {
      artifact_path: 'a.jsonl',
      event_id: EVENT_ID,
      occurrences: 2,
    });
    const second = ingestionFinding('CAUSAL_PREDECESSOR_MISSING', 'second', {
      artifact_path: 'a.jsonl',
      occurrences: 3,
    });
    assert.deepEqual(mergeFindings([first, second]), [{ ...first, detail: 'first (and 1 more)', occurrences: 5 }]);
  });

  it('keeps findings that differ in code, artifact or instance, in first-appearance order', () => {
    const findings = [
      ingestionFinding('SOURCE_SEQUENCE_GAP', 'd', { artifact_path: 'a.jsonl', source_instance_key: 'k1' }),
      ingestionFinding('SOURCE_SEQUENCE_GAP', 'd', { artifact_path: 'a.jsonl', source_instance_key: 'k2' }),
      ingestionFinding('SOURCE_SEQUENCE_GAP', 'd', { artifact_path: 'b.jsonl', source_instance_key: 'k1' }),
      ingestionFinding('CONFLICTING_SOURCE_SEQUENCE', 'd', { artifact_path: 'a.jsonl', source_instance_key: 'k1' }),
      ingestionFinding('ARTIFACT_MISSING', 'd'),
    ];
    assert.deepEqual(mergeFindings(findings), findings);
  });
});
