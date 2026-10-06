// Reading the frozen oracle results to reassess (AC-RUA-030): each is read from its exact stored
// bytes, its reference carries the digest of those bytes, and a result that cannot be reassessed
// refuses the assessment with a reason naming it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { JsonObject, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { readFrozenTrials } from '../../../../src/trial-oracle/late-evidence/frozen-results.ts';
import type { FrozenExecution } from '../../../../src/trial-oracle/late-evidence/frozen-results.ts';
import type { FrozenTrialEvidence } from '../../../../src/trial-oracle/late-evidence/late-evidence-input.ts';
import { ORACLE_VALIDATOR } from '../support/built-trials.ts';
import { CONVENTIONAL_CONTROL, CONVENTIONAL_TREATMENT } from '../support/trial-plans.ts';
import { frozenFixture, runIdOf, firstOf, refusalOf } from './support/late-fixtures.ts';

const encoder = new TextEncoder();
const control = frozenFixture(CONVENTIONAL_CONTROL);
const treatment = frozenFixture(CONVENTIONAL_TREATMENT);
const EXECUTION: FrozenExecution = {
  execution: { run_id: runIdOf(control) },
  execution_manifest_sha256: control.result.execution_manifest_sha256,
};
const OTHER_ID = '6f1d3b5a-7c9e-4b2d-8f4a-1c3e5a7b9d02';

function withResult(members: JsonObject, path = control.evidence.result.path): FrozenTrialEvidence {
  const document = { ...(control.result as unknown as JsonObject), ...members };
  return { frozen: control.frozen, result: { path, bytes: encoder.encode(`${canonicalJson(document)}\n`) } };
}

function refusalCodes(
  trials: readonly FrozenTrialEvidence[],
  execution: FrozenExecution = EXECUTION,
): readonly string[] {
  const read = readFrozenTrials(trials, execution, ORACLE_VALIDATOR);
  return read.ok ? [] : read.error.map((reason) => reason.code);
}

describe('readFrozenTrials', () => {
  it('reads every frozen result in order with the digest of its stored bytes', () => {
    const read = readFrozenTrials([control.evidence, treatment.evidence], EXECUTION, ORACLE_VALIDATOR);
    assert.ok(read.ok);
    assert.deepEqual(
      read.value.map((trial) => [trial.result.trial_id, trial.result_ref.artifact_sha256]),
      [
        [control.result.trial_id, sha256Hex(control.evidence.result.bytes)],
        [treatment.result.trial_id, sha256Hex(treatment.evidence.result.bytes)],
      ],
    );
    assert.equal(firstOf(read.value).frozen, control.frozen);
    assert.equal(
      firstOf(read.value).result_ref.artifact_path,
      `trials/${control.result.trial_id}/derived/oracle-result.json`,
    );
  });

  it('reads no trial from no frozen result', () => {
    assert.deepEqual(readFrozenTrials([], EXECUTION, ORACLE_VALIDATOR), { ok: true, value: [] });
  });

  it('refuses a result that is not JSON or not an oracle_result', () => {
    const unreadable = {
      frozen: control.frozen,
      result: { path: control.evidence.result.path, bytes: encoder.encode('{') },
    };
    assert.deepEqual(refusalCodes([unreadable]), ['FROZEN_RESULT_UNREADABLE']);
    const read = readFrozenTrials([withResult({ preservation_verdict: 'maybe' })], EXECUTION, ORACLE_VALIDATOR);
    assert.equal(read.ok, false);
    const reason = firstOf(refusalOf(read));
    assert.deepEqual(
      [reason.code, reason.subject, reason.artifact_path],
      ['FROZEN_RESULT_INVALID', 'BR-RUA-043', control.evidence.result.path],
    );
    assert.match(reason.detail, /preservation_verdict.*; expected a valid oracle_result$/);
  });

  it('refuses a result of another execution or execution manifest', () => {
    assert.deepEqual(refusalCodes([withResult({ run_id: OTHER_ID })]), ['FROZEN_RESULT_FOREIGN']);
    const other = withResult({ execution_manifest_sha256: 'b'.repeat(64) });
    const read = readFrozenTrials([other], EXECUTION, ORACLE_VALIDATOR);
    assert.match(
      firstOf(refusalOf(read)).detail,
      /names another execution or execution manifest "b{64}"; expected [0-9a-f]{64}/,
    );
    const validation: FrozenExecution = { ...EXECUTION, execution: { variant_validation_id: OTHER_ID as Uuid4 } };
    assert.deepEqual(refusalCodes([control.evidence], validation), ['FROZEN_RESULT_FOREIGN']);
  });

  it('refuses a result stored elsewhere than its trial directory', () => {
    const misplaced = withResult({}, `trials/${treatment.result.trial_id}/derived/oracle-result.json`);
    const read = readFrozenTrials([misplaced], EXECUTION, ORACLE_VALIDATOR);
    assert.deepEqual(
      refusalOf(read).map((reason) => reason.code),
      ['FROZEN_RESULT_MISPLACED'],
    );
    assert.match(
      firstOf(refusalOf(read)).detail,
      /is stored at ".*"; expected trials\/.*\/derived\/oracle-result.json/,
    );
  });

  it('refuses a second result of one trial and reports every refusal', () => {
    assert.deepEqual(refusalCodes([control.evidence, treatment.evidence, control.evidence]), [
      'FROZEN_TRIAL_DUPLICATE',
    ]);
    assert.deepEqual(refusalCodes([withResult({ run_id: OTHER_ID }), control.evidence, control.evidence]), [
      'FROZEN_RESULT_FOREIGN',
      'FROZEN_TRIAL_DUPLICATE',
    ]);
  });
});
