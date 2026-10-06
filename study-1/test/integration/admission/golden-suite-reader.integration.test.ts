// The production golden-suite port (BR-RUA-055, design §10.1 A9, D-18) over a real miniature
// suite: it runs `npm run test:golden -- --report-json <path>` through the real command runner,
// returns the runner's exit code and exact report bytes, and loads every trial-oracle case
// declaration. A9 then attests a final, covering run and refuses a failing one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseSuiteReport } from '../../../src/admission/golden-report.ts';
import { GoldenSuiteReader } from '../../../src/admission/node/golden-suite-reader.ts';
import { ruleCoverage } from '../../../src/admission/oracle-attestation.ts';
import { ChildProcessCommandRunner } from '../../../src/deployment-assembly/node/child-process-command-runner.ts';
import { TemporaryGoldenSuite } from '../../support/admission/temporary-golden-suite.ts';
import type { MiniatureGoldenCase } from '../../support/admission/temporary-golden-suite.ts';

function reader(suite: TemporaryGoldenSuite, npmExecutable = 'npm'): GoldenSuiteReader {
  return new GoldenSuiteReader({
    runner: new ChildProcessCommandRunner(),
    studyRoot: suite.studyRoot,
    reportPath: suite.reportPath,
    npmExecutable,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
  });
}

const PASSING: readonly MiniatureGoldenCase[] = [
  { case_id: 'covers-traceability', rule_id: 'traceability', passes: true },
  { case_id: 'covers-br-rua-006', rule_id: 'BR-RUA-006', passes: true },
];

describe('GoldenSuiteReader', () => {
  it('reads a passing run: exit 0, the exact report and every case declaration', async () => {
    const suite = TemporaryGoldenSuite.create(PASSING);
    try {
      const run = await reader(suite).readGoldenSuiteRun();
      assert.ok(run.ok, JSON.stringify(run));
      assert.equal(run.value.exit_code, 0);
      assert.equal(run.value.command, `npm run test:golden -- --report-json ${suite.reportPath}`);
      assert.deepEqual(run.value.report_bytes, new Uint8Array(readFileSync(suite.reportPath)));
      const report = parseSuiteReport(run.value.report_bytes);
      assert.ok(report.ok, JSON.stringify(report));
      assert.deepEqual(report.value.counts, { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 });
      assert.equal(report.value.minimum, 2);
      assert.deepEqual(run.value.case_declarations, [
        { case_id: 'covers-br-rua-006', rule_outcomes: [{ rule_id: 'BR-RUA-006', outcome: 'pass' }] },
        { case_id: 'covers-traceability', rule_outcomes: [{ rule_id: 'traceability', outcome: 'pass' }] },
      ]);
      assert.deepEqual(
        ruleCoverage(run.value.case_declarations, report.value.passed_tests).map((entry) => entry.rule_id),
        ['traceability', 'BR-RUA-006'],
      );
    } finally {
      suite.dispose();
    }
  });

  it('reads a failing run with exit 1 and the failure counted', async () => {
    const suite = TemporaryGoldenSuite.create([
      ...PASSING,
      { case_id: 'covers-g', rule_id: 'BR-RUA-029', passes: false },
    ]);
    try {
      const run = await reader(suite).readGoldenSuiteRun();
      assert.ok(run.ok);
      assert.equal(run.value.exit_code, 1);
      const report = parseSuiteReport(run.value.report_bytes);
      assert.ok(report.ok);
      assert.equal(report.value.counts.failed, 1);
      assert.equal(report.value.exit_code, 1);
      assert.deepEqual(report.value.passed_tests.map((test) => test.name).sort(), [
        'covers-br-rua-006',
        'covers-traceability',
      ]);
    } finally {
      suite.dispose();
    }
  });

  it('fails without a report when npm cannot start', async () => {
    const suite = TemporaryGoldenSuite.create(PASSING);
    try {
      const run = await reader(suite, '/nonexistent/npm').readGoldenSuiteRun();
      assert.ok(!run.ok);
      assert.equal(run.error.code, 'GOLDEN_SUITE_NOT_STARTED');
    } finally {
      suite.dispose();
    }
  });

  it('fails when the script exits without writing a report', async () => {
    const suite = TemporaryGoldenSuite.create(PASSING);
    try {
      const run = await reader(suite, process.execPath).readGoldenSuiteRun();
      assert.ok(!run.ok);
      assert.equal(run.error.code, 'GOLDEN_REPORT_UNREADABLE');
    } finally {
      suite.dispose();
    }
  });
});
