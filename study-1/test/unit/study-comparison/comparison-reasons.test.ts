// The reason vocabulary of this feature and its two collection helpers: reasons deduplicated by
// value in first-seen order, references sorted canonically with duplicates dropped (BR-RUA-035).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EvidenceRef } from '../../../src/record-contract/evidence-refs.ts';
import type { Sha256Hex, StructuredReason, Uuid4 } from '../../../src/record-contract/primitives.ts';
import {
  STUDY_COMPARISON_REASON_CODES,
  comparisonReason,
  uniqueReasons,
  uniqueSortedRefs,
} from '../../../src/study-comparison/comparison-reasons.ts';

const SHA_A = 'a'.repeat(64) as Sha256Hex;
const SHA_B = 'b'.repeat(64) as Sha256Hex;

describe('comparisonReason', () => {
  it('omits artifact_path when none is given', () => {
    assert.deepEqual(comparisonReason('UNDECLARED_DIFFERENCE', 'x.y', 'detail'), {
      code: 'UNDECLARED_DIFFERENCE',
      subject: 'x.y',
      detail: 'detail',
    });
  });

  it('carries the artifact path when given', () => {
    assert.deepEqual(comparisonReason('ARTIFACT_MISSING', 's', 'd', 'a/b.json'), {
      code: 'ARTIFACT_MISSING',
      subject: 's',
      artifact_path: 'a/b.json',
      detail: 'd',
    });
  });

  it('has a closed, duplicate-free code list', () => {
    assert.equal(new Set(STUDY_COMPARISON_REASON_CODES).size, STUDY_COMPARISON_REASON_CODES.length);
  });
});

describe('uniqueReasons', () => {
  it('drops structural duplicates and keeps first-seen order', () => {
    const missing = comparisonReason('ORACLE_RESULT_MISSING', 't1', 'absent', 'p');
    const invalid = comparisonReason('TRIAL_NOT_VALID', 't2', 'invalid');
    assert.deepEqual(uniqueReasons([missing, invalid, { ...missing }, invalid]), [missing, invalid]);
  });

  it('distinguishes reasons that differ only in artifact path or event id', () => {
    const base: StructuredReason = { code: 'C', subject: 's', detail: 'd' };
    const eventId = '0d6f4c2e-8a1b-4d3c-9e7f-5a6b7c8d9e0f' as Uuid4;
    const reasons: readonly StructuredReason[] = [
      base,
      { ...base, artifact_path: 'p' },
      { ...base, event_id: eventId },
    ];
    assert.deepEqual(uniqueReasons(reasons), reasons);
  });
});

describe('uniqueSortedRefs', () => {
  it('sorts canonically and drops equal neighbours', () => {
    const second: EvidenceRef = { artifact_path: 'b.json', artifact_sha256: SHA_A };
    const first: EvidenceRef = { artifact_path: 'a.json', artifact_sha256: SHA_B };
    const pointer: EvidenceRef = { ...first, json_pointer: '/x' };
    assert.deepEqual(uniqueSortedRefs([second, pointer, first, second, { ...first }]), [first, pointer, second]);
  });

  it('is empty for no references', () => {
    assert.deepEqual(uniqueSortedRefs([]), []);
  });
});
