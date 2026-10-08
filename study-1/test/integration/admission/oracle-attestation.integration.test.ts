// AC-RUA-055 (attestation part; BR-RUA-055, design §10.1 A9, §14 row 055): admission rejects with
// ORACLE_NOT_FINAL when the golden suite run at the admitted commit fails or leaves a
// verdict-changing rule uncovered, records the `oracle_revision_check` it judged, and reads no
// qualification or account state after that rejection. A final run passes A9 and the check is
// frozen into the admitted package.
//
// Boundary: the production `admitExecution` over the admission harness; the golden run is the
// FakeGoldenSuiteRunner, whose report bytes are what `tools/run-suite.ts` writes (its
// conformance test proves that against the real runner).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { isJsonObject } from '../../../src/record-contract/json-value.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { AdmissionOutcome } from '../../../src/admission/admission-ports.ts';
import { AdmissionHarness } from '../../support/admission/admission-harness.ts';

async function assertOracleNotFinal(
  harness: AdmissionHarness,
  outcome: AdmissionOutcome,
  detail: RegExp,
): Promise<void> {
  assert.equal(outcome.kind, 'rejected', JSON.stringify(outcome));
  assert.ok(outcome.reasons.every((reason) => reason.code === 'ORACLE_NOT_FINAL' && reason.subject === 'BR-RUA-055'));
  assert.ok(
    outcome.reasons.some((reason) => detail.test(reason.detail)),
    JSON.stringify(outcome.reasons),
  );
  const rejection = await harness.rejection(outcome.admission_attempt_id);
  assert.ok(rejection !== undefined && isJsonObject(rejection));
  assert.equal(rejection['rejection_class'], 'SAFETY');
  assert.equal(rejection['failed_check_id'], 'A9');
  assert.deepEqual(harness.packages.selections(), [], 'no qualification is read after A9 rejects');
  assert.deepEqual(await harness.packagePaths(), []);
  assert.equal(harness.mutationLog.isEmpty(), true);
}

describe('AC-RUA-055 admission attests the oracle before execution', () => {
  it('failing-report', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.goldenSuite.failTests(2);
    await assertOracleNotFinal(harness, await harness.admit(), /exited 1; expected exit code 0/);
  });

  it('under-covered-report', async () => {
    const harness = await AdmissionHarness.create('RUN');
    harness.goldenSuite.uncover('BR-RUA-029');
    harness.goldenSuite.uncover('traceability');
    await assertOracleNotFinal(
      harness,
      await harness.admit(),
      /^no passing golden case covers traceability, BR-RUA-029; expected every verdict-changing rule covered$/,
    );
  });

  it('below-minimum-report', async () => {
    const harness = await AdmissionHarness.create('TRANSPORT_PROBE');
    harness.goldenSuite.requireMinimum(500);
    await assertOracleNotFinal(
      harness,
      await harness.admit(),
      /golden tests ran; expected at least the summed minimum 500/,
    );
  });

  it('unrunnable-suite', async () => {
    const harness = await AdmissionHarness.create('VARIANT_VALIDATION');
    harness.goldenSuite.failWith('GOLDEN_SUITE_NOT_STARTED', 'spawn npm ENOENT');
    await assertOracleNotFinal(harness, await harness.admit(), /GOLDEN_SUITE_NOT_STARTED: spawn npm ENOENT/);
  });

  it('final-report-is-frozen', async () => {
    const harness = await AdmissionHarness.create('RUN');
    const outcome = await harness.admit();
    assert.equal(outcome.kind, 'admitted', JSON.stringify(outcome));
    const directory = outcome.manifest_path.slice(0, -EXECUTION_PATHS.executionManifest.length);
    const check = parseJsonDocument(await harness.evidenceFile(`${directory}${EXECUTION_PATHS.oracleRevisionCheck}`));
    assert.ok(check.ok && isJsonObject(check.value));
    assert.equal(harness.validator.validateAs('oracle_revision_check', check.value).valid, true);
    assert.equal(check.value['result'], 'passed');
    assert.deepEqual(check.value['uncovered'], []);
    assert.equal(check.value['admission_attempt_id'], outcome.admission_attempt_id);
    assert.equal(harness.goldenSuite.runCount(), 1);
  });
});
