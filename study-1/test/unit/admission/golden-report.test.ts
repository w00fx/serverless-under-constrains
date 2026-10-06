// The run-suite report reader and the case-declaration reader (BR-RUA-055, D-18): a report is
// read only when every judged member has its written type; a case declaration counts only when
// its id and every pair are own strings.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { caseDeclarationOf, parseSuiteReport } from '../../../src/admission/golden-report.ts';

const encoder = new TextEncoder();
const REPORT = {
  suite: 'golden',
  patterns: ['test/golden/**/*.golden.test.ts'],
  files: [],
  counts: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 },
  minimum: 2,
  exit_code: 0,
  problems: [],
  passed_tests: [{ file: '/s/test/golden/trial-oracle/a.golden.test.ts', name: 'case-a' }],
};
const bytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

describe('parseSuiteReport', () => {
  it('reads the judged members of a report', () => {
    assert.deepEqual(parseSuiteReport(bytes(REPORT)), {
      ok: true,
      value: {
        suite: 'golden',
        counts: REPORT.counts,
        minimum: 2,
        exit_code: 0,
        passed_tests: REPORT.passed_tests,
      },
    });
  });

  it('names the first member that is not as written', () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [[], 'the report is array []; expected a JSON object'],
      [{ ...REPORT, suite: 1 }, 'suite is number 1; expected a string'],
      [
        { ...REPORT, minimum: -1 },
        'minimum is number -1 and exit_code is number 0; expected two nonnegative safe integers',
      ],
      [
        { ...REPORT, exit_code: 1.5 },
        'minimum is number 2 and exit_code is number 1.5; expected two nonnegative safe integers',
      ],
      [
        { ...REPORT, counts: null },
        'counts is null null; expected an object of tests, passed, failed, cancelled, skipped, todo',
      ],
      [
        { ...REPORT, counts: { ...REPORT.counts, todo: '0' } },
        'counts.todo is string "0"; expected a nonnegative safe integer',
      ],
      [{ ...REPORT, passed_tests: {} }, 'passed_tests is object {}; expected an array of {file, name}'],
      [
        { ...REPORT, passed_tests: [{ file: 'f' }] },
        'passed_tests[0] is object {"file":"f"}; expected {file: string, name: string}',
      ],
      [{ ...REPORT, passed_tests: [7] }, 'passed_tests[0] is number 7; expected {file: string, name: string}'],
    ];
    for (const [report, detail] of cases) {
      assert.deepEqual(parseSuiteReport(bytes(report)), { ok: false, error: detail });
    }
  });

  it('refuses bytes that are not one JSON document', () => {
    const parsed = parseSuiteReport(encoder.encode('{"suite":'));
    assert.ok(!parsed.ok);
    assert.match(parsed.error, /^the report is not one JSON document \(/);
  });

  it('tolerates members it does not judge', () => {
    assert.ok(parseSuiteReport(bytes({ ...REPORT, diagnostics: { slow: [] } })).ok);
  });
});

describe('caseDeclarationOf', () => {
  it('reads an id and its pairs', () => {
    assert.deepEqual(
      caseDeclarationOf({
        case_id: 'c',
        rule_outcomes_reached: [{ rule_id: 'BR-RUA-006', outcome: 'pass' }],
        extra: 1,
      }),
      { case_id: 'c', rule_outcomes: [{ rule_id: 'BR-RUA-006', outcome: 'pass' }] },
    );
  });

  it('reads nothing from a value without own string members', () => {
    const inherited = Object.create({ case_id: 'c', rule_outcomes_reached: [] }) as object;
    for (const value of [
      undefined,
      null,
      'c',
      { case_id: 1, rule_outcomes_reached: [] },
      { case_id: 'c' },
      inherited,
    ]) {
      assert.equal(caseDeclarationOf(value), undefined);
    }
  });

  it('reads nothing when any pair is malformed', () => {
    assert.equal(
      caseDeclarationOf({
        case_id: 'c',
        rule_outcomes_reached: [{ rule_id: 'BR-RUA-006', outcome: 'pass' }, { rule_id: 6 }],
      }),
      undefined,
    );
  });
});
