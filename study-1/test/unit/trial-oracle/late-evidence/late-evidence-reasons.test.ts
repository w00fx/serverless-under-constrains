// Late problems become one reason per code (A-12): the first problem's place and detail, with the
// count of the others, in order of first appearance, each naming BR-RUA-043.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LATE_EVIDENCE_SUBJECT,
  LATE_PROBLEM_CODES,
  describeFirstViolation,
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

  it('keeps a long first detail whole, so its expected shape survives the count', () => {
    const detail = `line 1: late_record "${'x'.repeat(300)}"; expected a valid ledger_snapshot`;
    const problem: LateProblem = { ...at('LATE_RECORD_SCHEMA_INVALID', 1), detail };
    assert.deepEqual(
      lateProblemReasons([problem, problem]).map((reason) => reason.detail),
      [`${detail} (and 1 more)`],
    );
  });

  it('names BR-RUA-043 and a closed set of codes', () => {
    assert.equal(LATE_EVIDENCE_SUBJECT, 'BR-RUA-043');
    assert.equal(new Set(LATE_PROBLEM_CODES).size, LATE_PROBLEM_CODES.length);
    assert.ok(LATE_PROBLEM_CODES.every((code) => /^LATE_[A-Z_]+$/.test(code)));
  });
});

describe('describeFirstViolation', () => {
  it('quotes the first violation as bounded JSON text, path then detail', () => {
    const violations = [
      { instance_path: '/pages', keyword: 'type', detail: 'must be array' },
      { instance_path: '/sequence', keyword: 'type', detail: 'must be integer' },
    ];
    assert.equal(describeFirstViolation(violations), '"/pages must be array"');
  });

  it('bounds an untrusted path and quotes no violation as empty text', () => {
    const long = describeFirstViolation([
      { instance_path: `/${'x'.repeat(1000)}`, keyword: 'additionalProperties', detail: 'is unknown' },
    ]);
    assert.ok(long.length < 1000, `${String(long.length)} chars; expected a bounded quotation`);
    assert.equal(describeFirstViolation([]), '""');
  });
});
