// Late problems become one reason per code (A-12): the first problem's place and detail, with the
// count of the others, in order of first appearance, each naming BR-RUA-043.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LATE_EVIDENCE_SUBJECT,
  LATE_PROBLEM_CODES,
  lateProblemReasons,
} from '../../../../src/trial-oracle/late-evidence/late-evidence-reasons.ts';
import type { LateProblem } from '../../../../src/trial-oracle/late-evidence/late-evidence-reasons.ts';

const at = (code: LateProblem['code'], line: number): LateProblem => ({
  code,
  artifact_path: 'late-evidence/late-evidence-stream.jsonl',
  detail: `line ${String(line)}: broken`,
});

describe('lateProblemReasons', () => {
  it('gives no reason for no problem', () => {
    assert.deepEqual(lateProblemReasons([]), []);
  });

  it('aggregates problems per code in order of first appearance', () => {
    const reasons = lateProblemReasons([
      at('LATE_SEQUENCE_BROKEN', 3),
      at('LATE_RECORD_UNREADABLE', 4),
      at('LATE_SEQUENCE_BROKEN', 7),
      at('LATE_SEQUENCE_BROKEN', 9),
    ]);
    assert.deepEqual(reasons, [
      {
        code: 'LATE_SEQUENCE_BROKEN',
        subject: 'BR-RUA-043',
        artifact_path: 'late-evidence/late-evidence-stream.jsonl',
        detail: 'line 3: broken (and 2 more)',
      },
      {
        code: 'LATE_RECORD_UNREADABLE',
        subject: 'BR-RUA-043',
        artifact_path: 'late-evidence/late-evidence-stream.jsonl',
        detail: 'line 4: broken',
      },
    ]);
  });

  it('names BR-RUA-043 and a closed set of codes', () => {
    assert.equal(LATE_EVIDENCE_SUBJECT, 'BR-RUA-043');
    assert.equal(new Set(LATE_PROBLEM_CODES).size, LATE_PROBLEM_CODES.length);
    assert.ok(LATE_PROBLEM_CODES.every((code) => /^LATE_[A-Z_]+$/.test(code)));
  });
});
