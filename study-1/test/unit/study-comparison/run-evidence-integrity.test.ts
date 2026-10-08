// The run-level evidence integrity (CTR-RUA-002, INV-RUA-001 execution scope): each trial's G8 gate
// and identity integrity, plus no provider transaction id in two trials; `invalid > unverified >
// verified`, and a missing result is `unverified`.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { DeclaredTrial } from '../../../src/record-contract/records/group-a/execution_manifest.ts';
import {
  deriveRunEvidenceIntegrity,
  missingOracleResultReason,
  oracleResultPath,
} from '../../../src/study-comparison/run-evidence-integrity.ts';
import type { OracleResultsByTrial } from '../../../src/study-comparison/run-evidence-integrity.ts';
import { cleanRunRecords } from './support/clean-run.ts';
import { editResult, resultsOf, withEvidenceGate } from './support/frozen-results.ts';

let trials: readonly DeclaredTrial[];
let results: OracleResultsByTrial;
let first: Uuid4;
let second: Uuid4;

before(async () => {
  const records = await cleanRunRecords();
  trials = records.execution_manifest.record.trials;
  results = resultsOf(records);
  first = trials[0]?.trial_id ?? ('' as Uuid4);
  second = trials[1]?.trial_id ?? ('' as Uuid4);
});

function codes(integrity: ReturnType<typeof deriveRunEvidenceIntegrity>): readonly string[] {
  return integrity.reasons.map((reason) => `${reason.code}:${reason.subject}`);
}

describe('deriveRunEvidenceIntegrity', () => {
  it('is verified with no reason when every result is verified and identities are unique', () => {
    assert.deepEqual(deriveRunEvidenceIntegrity(trials, results), { status: 'verified', reasons: [] });
  });

  it('is unverified with ORACLE_RESULT_MISSING for a trial without a result', () => {
    const integrity = deriveRunEvidenceIntegrity(trials, editResult(results, first, null));
    assert.equal(integrity.status, 'unverified');
    assert.deepEqual(integrity.reasons, [missingOracleResultReason(first)]);
  });

  it('carries an unverified or invalid G8 gate', () => {
    const unverified = deriveRunEvidenceIntegrity(
      trials,
      editResult(results, first, (r) => withEvidenceGate(r, 'unverified')),
    );
    assert.equal(unverified.status, 'unverified');
    assert.deepEqual(codes(unverified), [`EVIDENCE_INTEGRITY_NOT_VERIFIED:${first}`]);
    assert.match(
      unverified.reasons.map((reason) => reason.detail).join('\n'),
      /has evidence_integrity gate unverified; expected verified$/,
    );
    const invalid = deriveRunEvidenceIntegrity(
      trials,
      editResult(results, first, (r) => withEvidenceGate(r, 'invalid')),
    );
    assert.equal(invalid.status, 'invalid');
    assert.deepEqual(
      invalid.reasons.map((reason) => reason.artifact_path),
      [oracleResultPath(first)],
    );
  });

  it('carries an identity integrity below verified', () => {
    const integrity = deriveRunEvidenceIntegrity(
      trials,
      editResult(results, second, (record) => ({ ...record, identity_integrity: 'unverified' })),
    );
    assert.equal(integrity.status, 'unverified');
    assert.match(
      integrity.reasons.map((reason) => reason.detail).join('\n'),
      /has identity_integrity unverified; expected verified$/,
    );
  });

  it('is invalid over unverified when both occur', () => {
    const edited = editResult(
      editResult(results, first, (r) => withEvidenceGate(r, 'unverified')),
      second,
      (r) => withEvidenceGate(r, 'invalid'),
    );
    assert.equal(deriveRunEvidenceIntegrity(trials, edited).status, 'invalid');
  });

  it('is invalid when a provider transaction id appears in two trials', () => {
    const reused = results.get(first)?.record.monetary_observations.provider_transaction_ids[0];
    assert.ok(reused !== undefined);
    const edited = editResult(results, second, (record) => ({
      ...record,
      monetary_observations: { ...record.monetary_observations, provider_transaction_ids: [reused, reused] },
    }));
    const integrity = deriveRunEvidenceIntegrity(trials, edited);
    assert.equal(integrity.status, 'invalid');
    assert.deepEqual(codes(integrity), [`CROSS_TRIAL_IDENTITY_REUSE:${reused}`]);
    assert.match(
      integrity.reasons.map((reason) => reason.detail).join('\n'),
      new RegExp(`reported by trials ${first}, ${second};`),
    );
  });
});

describe('oracleResultPath and missingOracleResultReason', () => {
  it('locate the derived oracle result of a trial', () => {
    assert.equal(oracleResultPath(first), `trials/${first}/derived/oracle-result.json`);
    assert.deepEqual(missingOracleResultReason(first), {
      code: 'ORACLE_RESULT_MISSING',
      subject: first,
      artifact_path: `trials/${first}/derived/oracle-result.json`,
      detail: `trials/${first}/derived/oracle-result.json is absent; expected the frozen oracle result of trial ${first}`,
    });
  });
});
