// Step A9 (BR-RUA-055): the oracle_revision_check of a golden run, passed only when the run exited
// 0, its report reads, at least the minimum ran, nothing failed, was cancelled, skipped or todo,
// and a passing trial-oracle case covers every verdict-changing rule.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GoldenSuiteRun } from '../../../src/admission/admission-ports.ts';
import {
  assessOracleAttestation,
  oracleRevisionCheck,
  ruleCoverage,
} from '../../../src/admission/oracle-attestation.ts';
import type { AttestationContext } from '../../../src/admission/oracle-attestation.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonValue, UtcMillis, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { VERDICT_CHANGING_RULES } from '../../../src/trial-oracle/oracle-vocabulary.ts';
import { FakeGoldenSuiteRunner } from '../../support/admission/fake-golden-suite-runner.ts';

const validator = createRecordValidator();
const CONTEXT: AttestationContext = {
  admission_attempt_id: '0000a001-0000-4000-8000-000000000001' as Uuid4,
  commit_sha: '1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c',
  tree_sha: '9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d',
  node_version: 'v24.15.0',
  checked_at: '2026-10-06T09:00:00.000Z' as UtcMillis,
};

async function runOf(golden: FakeGoldenSuiteRunner = new FakeGoldenSuiteRunner()): Promise<GoldenSuiteRun> {
  const run = await golden.readGoldenSuiteRun();
  assert.ok(run.ok);
  return run.value;
}

function details(run: GoldenSuiteRun): readonly string[] {
  return oracleRevisionCheck(run, CONTEXT).reasons.map((reason) => reason.detail);
}

describe('oracleRevisionCheck', () => {
  it('passes a final, covering run and states it', async () => {
    const run = await runOf();
    const record = oracleRevisionCheck(run, CONTEXT);
    assert.equal(record.result, 'passed');
    assert.deepEqual(record.reasons, []);
    assert.deepEqual(record.uncovered, []);
    assert.equal(record.rule_coverage.length, VERDICT_CHANGING_RULES.length);
    assert.equal(record.report_sha256, sha256Hex(run.report_bytes));
    assert.deepEqual(record.test_counts, {
      tests: VERDICT_CHANGING_RULES.length,
      pass: VERDICT_CHANGING_RULES.length,
      fail: 0,
      skipped: 0,
      todo: 0,
    });
    assert.equal(record.admission_attempt_id, CONTEXT.admission_attempt_id);
    assert.equal(validator.validateAs('oracle_revision_check', record as unknown as JsonValue).valid, true);
  });

  it('omits the attempt id outside admission', async () => {
    const { admission_attempt_id: _attempt, ...revision } = CONTEXT;
    const record = oracleRevisionCheck(await runOf(), revision);
    assert.equal(Object.hasOwn(record, 'admission_attempt_id'), false);
  });

  it('fails a non-zero exit and failed or cancelled tests', async () => {
    const golden = new FakeGoldenSuiteRunner();
    golden.failTests(2);
    const run = await runOf(golden);
    assert.match(details(run)[0] ?? '', / exited 1; expected exit code 0$/);
    assert.equal(details(run)[1], '2 failed, 0 cancelled, 0 skipped and 0 todo golden tests; expected none');
    const cancelled = {
      ...run,
      report_bytes: new TextEncoder().encode(
        new TextDecoder().decode(run.report_bytes).replace('"cancelled": 0', '"cancelled": 3'),
      ),
    };
    assert.equal(oracleRevisionCheck(cancelled, CONTEXT).test_counts.fail, 5);
  });

  it('fails fewer tests than the minimum', async () => {
    const golden = new FakeGoldenSuiteRunner();
    golden.requireMinimum(400);
    assert.deepEqual(details(await runOf(golden)), [
      `${String(VERDICT_CHANGING_RULES.length)} golden tests ran; expected at least the summed minimum 400`,
    ]);
  });

  it('fails an unreadable report with zero counts and every rule uncovered', async () => {
    const golden = new FakeGoldenSuiteRunner();
    golden.writeReport(new TextEncoder().encode('not json'));
    const record = oracleRevisionCheck(await runOf(golden), CONTEXT);
    assert.equal(record.result, 'failed');
    assert.deepEqual(record.test_counts, { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 });
    assert.equal(record.golden_minimum, 0);
    assert.deepEqual(record.uncovered, VERDICT_CHANGING_RULES);
    assert.match(record.reasons[0].detail, /^the golden report is unreadable: the report is not one JSON document/);
    assert.equal(validator.validateAs('oracle_revision_check', record as unknown as JsonValue).valid, true);
  });

  it('fails an uncovered rule', async () => {
    const golden = new FakeGoldenSuiteRunner();
    golden.uncover('BR-RUA-030');
    assert.deepEqual(details(await runOf(golden)), [
      'no passing golden case covers BR-RUA-030; expected every verdict-changing rule covered',
    ]);
  });

  it('records an exit code outside 0..255 as 255', async () => {
    for (const code of [-1, 300, 1.5]) {
      const golden = new FakeGoldenSuiteRunner();
      golden.exitWith(code);
      assert.equal(oracleRevisionCheck(await runOf(golden), CONTEXT).exit_code, 255);
    }
  });
});

describe('assessOracleAttestation (A9)', () => {
  it('passes with the record and fails as SAFETY with ORACLE_NOT_FINAL', async () => {
    const verdict = assessOracleAttestation(await runOf(), CONTEXT);
    assert.ok(verdict.passed);
    assert.equal(verdict.value.result, 'passed');
    const golden = new FakeGoldenSuiteRunner();
    golden.failTests(1);
    const failing = assessOracleAttestation(await runOf(golden), CONTEXT);
    assert.ok(!failing.passed);
    assert.equal(failing.rejection_class, 'SAFETY');
    assert.ok(failing.reasons.every((reason) => reason.code === 'ORACLE_NOT_FINAL'));
    assert.deepEqual(failing.statement.expected, { exit_code: 0, fail: 0, skipped: 0, todo: 0, uncovered: 0 });
  });
});

describe('ruleCoverage', () => {
  const ORACLE_FILE = 'test/golden/trial-oracle/x.golden.test.ts';

  it('counts a case only when its test passed in a trial-oracle golden file', () => {
    const declarations = [
      { case_id: 'a', rule_outcomes: [{ rule_id: 'BR-RUA-006', outcome: 'pass' }] },
      { case_id: 'b', rule_outcomes: [{ rule_id: 'BR-RUA-006', outcome: 'fail' }] },
      { case_id: 'c', rule_outcomes: [{ rule_id: 'BR-RUA-001', outcome: 'pass' }] },
    ];
    const passedTests = [
      { file: ORACLE_FILE, name: 'a' },
      { file: '/abs/study-1/test/golden/trial-oracle/y.golden.test.ts', name: 'b' },
      { file: 'test/golden/settlement/z.golden.test.ts', name: 'c' },
    ];
    assert.deepEqual(ruleCoverage(declarations, passedTests), [
      { rule_id: 'BR-RUA-006', outcome: 'fail', case_ids: ['b'] },
      { rule_id: 'BR-RUA-006', outcome: 'pass', case_ids: ['a'] },
    ]);
  });

  it('orders the outcomes of one rule whatever order the cases declare them in', () => {
    const passedTests = ['p', 'f'].map((name) => ({ file: ORACLE_FILE, name }));
    const pass = { case_id: 'p', rule_outcomes: [{ rule_id: 'BR-RUA-003', outcome: 'pass' }] };
    const fail = { case_id: 'f', rule_outcomes: [{ rule_id: 'BR-RUA-003', outcome: 'fail' }] };
    const expected = [
      { rule_id: 'BR-RUA-003', outcome: 'fail', case_ids: ['f'] },
      { rule_id: 'BR-RUA-003', outcome: 'pass', case_ids: ['p'] },
    ];
    assert.deepEqual(ruleCoverage([pass, fail], passedTests), expected);
    assert.deepEqual(ruleCoverage([fail, pass], passedTests), expected);
  });

  it('merges cases of one pair, sorted, and drops pairs the record cannot hold', () => {
    const declarations = [
      { case_id: 'z', rule_outcomes: [{ rule_id: 'BR-RUA-002', outcome: 'pass' }] },
      {
        case_id: 'y',
        rule_outcomes: [
          { rule_id: 'BR-RUA-002', outcome: 'pass' },
          { rule_id: 'BR-RUA-002', outcome: 'Pass!' },
        ],
      },
      { case_id: 'x', rule_outcomes: [{ rule_id: 'BR-RUA-999', outcome: 'pass' }] },
    ];
    const passedTests = ['z', 'y', 'x'].map((name) => ({ file: ORACLE_FILE, name }));
    assert.deepEqual(ruleCoverage(declarations, passedTests), [
      { rule_id: 'BR-RUA-002', outcome: 'pass', case_ids: ['y', 'z'] },
    ]);
  });
});
