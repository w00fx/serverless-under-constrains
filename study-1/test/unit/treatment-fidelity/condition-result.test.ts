// The shared condition rules (BR-RUA-027, BR-RUA-034, BR-RUA-035): canonical references, the
// downgrade of a conclusive draft that cites affected evidence, and reasons only when indeterminate.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IngestionFinding } from '../../../src/evidence-ingestion/ingestion-model.ts';
import type { EvidenceRef } from '../../../src/record-contract/evidence-refs.ts';
import type { Sha256Hex, StructuredReason, Uuid4 } from '../../../src/record-contract/primitives.ts';
import {
  canonicalRefs,
  finishCondition,
  idOf,
  refOf,
  uniqueReasons,
} from '../../../src/treatment-fidelity/condition-result.ts';
import type { ConditionDraft } from '../../../src/treatment-fidelity/condition-result.ts';
import { PROBE_IDS, probeEvidence, treatmentView } from './support/treatment-evidence.ts';

const PATH = 'probe/journals/provider-journal.jsonl';
// A sorts before B: same artifact, smaller event id.
const A = { artifact_path: PATH, artifact_sha256: 'a'.repeat(64) as Sha256Hex, event_id: PROBE_IDS.release_event };
const B = { artifact_path: PATH, artifact_sha256: 'a'.repeat(64) as Sha256Hex, event_id: PROBE_IDS.commit_event };
const CALLER: EvidenceRef = {
  artifact_path: 'probe/journals/caller-journal.jsonl',
  artifact_sha256: 'b'.repeat(64) as Sha256Hex,
};
const MISSING: StructuredReason = {
  code: 'EVENT_MISSING',
  subject: 'BR-RUA-014',
  artifact_path: PATH,
  detail: 'no release',
};

function draft(
  result: ConditionDraft['result'],
  refs: ConditionDraft['refs'],
  reasons: readonly StructuredReason[] = [],
): ConditionDraft {
  return { result, expected: { want: true }, observed: { got: true }, refs, reasons };
}

function gap(eventId?: Uuid4): IngestionFinding {
  return {
    code: 'SOURCE_SEQUENCE_GAP',
    subject: 'BR-RUA-034',
    artifact_path: PATH,
    ...(eventId === undefined ? {} : { event_id: eventId }),
    detail: 'sequence 3 missing',
    occurrences: 1,
  };
}

describe('finishCondition', () => {
  it('keeps a conclusive draft on untouched evidence, with canonical refs and no reasons', () => {
    const result = finishCondition('BR-RUA-014', draft('pass', [B, undefined, A, B], [MISSING]), []);
    assert.deepEqual(result, {
      condition_id: 'BR-RUA-014',
      result: 'pass',
      expected: { want: true },
      observed: { got: true },
      evidence_refs: [A, B],
      indeterminate_reasons: [],
      affected_by: [],
    });
  });

  it('downgrades a conclusive draft whose evidence a finding touches, naming the codes', () => {
    const result = finishCondition('BR-RUA-014', draft('fail', [A]), [gap(), gap()]);
    assert.equal(result.result, 'indeterminate');
    assert.deepEqual(result.affected_by, ['SOURCE_SEQUENCE_GAP']);
    assert.deepEqual(
      result.indeterminate_reasons.map((reason) => reason.code),
      ['SOURCE_SEQUENCE_GAP'],
    );
  });

  it('sorts the affecting codes and keeps the draft reasons first', () => {
    const conflict: IngestionFinding = { ...gap(A.event_id), code: 'CONFLICTING_EVENT_CONTENT' };
    const result = finishCondition('BR-RUA-014', draft('indeterminate', [A], [MISSING]), [gap(), conflict]);
    assert.deepEqual(result.affected_by, ['CONFLICTING_EVENT_CONTENT', 'SOURCE_SEQUENCE_GAP']);
    assert.equal(result.indeterminate_reasons[0], MISSING);
  });

  it('keeps an indeterminate draft on untouched evidence with its own reasons', () => {
    const result = finishCondition('BR-RUA-014', draft('indeterminate', [CALLER], [MISSING, MISSING]), [gap()]);
    assert.deepEqual(result.indeterminate_reasons, [MISSING]);
    assert.deepEqual(result.affected_by, []);
  });
});

describe('condition helpers', () => {
  it('canonicalRefs sorts and drops duplicates', () => {
    assert.deepEqual(canonicalRefs([B, CALLER, A, B, CALLER]), [CALLER, A, B]);
    assert.deepEqual(canonicalRefs([]), []);
  });

  it('refOf and idOf read an event that may be absent', () => {
    const view = treatmentView(probeEvidence());
    assert.equal(refOf(view.commit)?.event_id, PROBE_IDS.commit_event);
    assert.equal(refOf(undefined), undefined);
    assert.equal(idOf(view.release), PROBE_IDS.release_event);
    assert.equal(idOf(undefined), null);
  });

  it('uniqueReasons keeps the first of reasons equal in every located member', () => {
    const otherSubject = { ...MISSING, subject: 'BR-RUA-012' };
    const otherEvent = { ...MISSING, event_id: PROBE_IDS.release_event };
    const otherDetail = { ...MISSING, detail: 'no release at all' };
    const unlocated: StructuredReason = { code: 'EVENT_MISSING', subject: 'BR-RUA-014', detail: 'no release' };
    assert.deepEqual(uniqueReasons([MISSING, otherSubject, MISSING, otherEvent, otherDetail, unlocated, unlocated]), [
      MISSING,
      otherSubject,
      otherEvent,
      otherDetail,
      unlocated,
    ]);
  });
});
