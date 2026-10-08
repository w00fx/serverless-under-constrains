// FakeGoldenSuiteRunner conformance (design §12.2): its report has exactly the members the real
// `tools/run-suite.ts` writes, its passing tests are named and located like the real ones (the
// case id, in an absolute trial-oracle golden path), its case declarations have the production
// reader's shape, and a failing run exits and counts like the real one.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GoldenSuiteRun } from '../../../../src/admission/admission-ports.ts';
import { GoldenSuiteReader } from '../../../../src/admission/node/golden-suite-reader.ts';
import { assessOracleAttestation } from '../../../../src/admission/oracle-attestation.ts';
import { ChildProcessCommandRunner } from '../../../../src/deployment-assembly/node/child-process-command-runner.ts';
import { isJsonObject } from '../../../../src/record-contract/json-value.ts';
import { parseJsonDocument } from '../../../../src/record-contract/parsing.ts';
import type { JsonValue, UtcMillis } from '../../../../src/record-contract/primitives.ts';
import { FakeGoldenSuiteRunner } from '../../../support/admission/fake-golden-suite-runner.ts';
import { TemporaryGoldenSuite } from '../../../support/admission/temporary-golden-suite.ts';

const CONTEXT = {
  commit_sha: '1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c',
  tree_sha: '9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d',
  node_version: 'v24.15.0',
  checked_at: '2026-10-06T09:00:00.000Z' as UtcMillis,
};

async function realRun(passes: boolean): Promise<GoldenSuiteRun> {
  const suite = TemporaryGoldenSuite.create([{ case_id: 'covers-traceability', rule_id: 'traceability', passes }]);
  try {
    const run = await new GoldenSuiteReader({
      runner: new ChildProcessCommandRunner(),
      studyRoot: suite.studyRoot,
      reportPath: suite.reportPath,
      npmExecutable: 'npm',
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    }).readGoldenSuiteRun();
    assert.ok(run.ok, JSON.stringify(run));
    return run.value;
  } finally {
    suite.dispose();
  }
}

function reportMembers(run: GoldenSuiteRun): readonly string[] {
  const parsed = parseJsonDocument(run.report_bytes);
  assert.ok(parsed.ok && isJsonObject(parsed.value));
  return Object.keys(parsed.value).sort();
}

describe('FakeGoldenSuiteRunner conforms to GoldenSuiteReader over run-suite', () => {
  it('writes the same report members and passing-test shape', async () => {
    const real = await realRun(true);
    const fakeRun = await new FakeGoldenSuiteRunner().readGoldenSuiteRun();
    assert.ok(fakeRun.ok);
    assert.deepEqual(reportMembers(fakeRun.value), reportMembers(real));
    const shape = (run: GoldenSuiteRun): readonly unknown[] => {
      const parsed = parseJsonDocument(run.report_bytes);
      assert.ok(parsed.ok && isJsonObject(parsed.value));
      const tests = parsed.value['passed_tests'];
      assert.ok(Array.isArray(tests));
      return tests.map((test: JsonValue) => {
        const file = isJsonObject(test) ? test['file'] : undefined;
        return [
          isJsonObject(test) ? Object.keys(test).sort() : [],
          typeof file === 'string' && file.includes('/test/golden/trial-oracle/'),
        ];
      });
    };
    assert.deepEqual(shape(fakeRun.value)[0], shape(real)[0]);
    assert.deepEqual(
      Object.keys(fakeRun.value.case_declarations[0] ?? {}),
      Object.keys(real.case_declarations[0] ?? {}),
    );
    assert.equal(fakeRun.value.exit_code, real.exit_code);
  });

  it('fails a run the way the real runner does', async () => {
    const real = await realRun(false);
    const fake = new FakeGoldenSuiteRunner();
    fake.failTests(1);
    const fakeRun = await fake.readGoldenSuiteRun();
    assert.ok(fakeRun.ok);
    assert.equal(fakeRun.value.exit_code, real.exit_code);
    const verdicts = [assessOracleAttestation(real, CONTEXT), assessOracleAttestation(fakeRun.value, CONTEXT)];
    for (const verdict of verdicts) {
      assert.equal(verdict.passed, false);
      assert.ok(!verdict.passed);
      assert.match(verdict.reasons.map((reason) => reason.detail).join('\n'), /1 failed, 0 cancelled/);
    }
  });
});
