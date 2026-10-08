// Reading the scientific evidence of a validation package back (BR-RUA-038, BR-RUA-044): summary
// and trial-manifest drift, missing results, and the anchors that cover each result.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import type { ValidationSummary } from '../../../src/record-contract/records/group-c/validation_summary.ts';
import { buildEvidenceIndex } from '../../../src/evidence-package/evidence-index.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { readAdmissionEvidence } from '../../../src/variant-validation/admission-evidence.ts';
import { readPackageTrialEvidence } from '../../../src/variant-validation/package-trial-evidence.ts';
import type { ScientificEvidence, TrialEvidence } from '../../../src/variant-validation/scientific-evidence.ts';
import { FIXTURE_DEPS, unwrap } from '../../support/evidence-package/probe-package-fixtures.ts';
import { RUN_ID, digest } from '../../support/record-contract/record-builders.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';
import { replaceFile, withoutFile } from '../../golden/variant-validation/support/golden-files.ts';
import { GOLDEN_IDENTITY, validationPackage } from '../../golden/variant-validation/support/validation-package.ts';
import {
  CONTROL_TRIAL_ID,
  GOLDEN_VALIDATION_ID,
  TREATMENT_TRIAL_ID,
  goldenAt,
} from '../../golden/variant-validation/support/validation-records.ts';
import { editRecord } from './support/package-edits.ts';

const FIXTURE = validationPackage();
const TREATMENT = { kind: 'trial', trial_id: TREATMENT_TRIAL_ID } as const;
const RESULT_PATH = PACKAGE_LAYOUT.unitFile(TREATMENT, 'oracleResult');
const TRIAL_MANIFEST_PATH = PACKAGE_LAYOUT.unitFile(TREATMENT, 'trialManifest');
const INDEX_PATH = PACKAGE_LAYOUT.unitFile(TREATMENT, 'evidenceIndex');

function evidenceOf(files: readonly PackageFile[], summary: ValidationSummary = FIXTURE.summary): ScientificEvidence {
  const admission = unwrap(readAdmissionEvidence(files, GOLDEN_VALIDATION_ID, FIXTURE_DEPS));
  return readPackageTrialEvidence({ files, admission, summary }, FIXTURE_DEPS);
}

function treatmentOf(evidence: ScientificEvidence): TrialEvidence {
  return evidence.trials[1];
}

function anchorProblems(files: readonly PackageFile[]): readonly string[] {
  const treatment = treatmentOf(evidenceOf(files));
  assert.equal(treatment.kind, 'frozen');
  return treatment.anchor_problems;
}

function driftDetails(evidence: ScientificEvidence): readonly string[] {
  assert.ok(evidence.defects.every((reason) => reason.code === 'MANIFEST_DRIFT'));
  return evidence.defects.map((reason) => reason.detail);
}

describe('readPackageTrialEvidence', () => {
  it('reads both trials of a sound package as frozen, anchored and drift-free', () => {
    const evidence = evidenceOf(FIXTURE.files);
    assert.deepEqual(evidence.defects, []);
    assert.deepEqual(
      evidence.trials.map((trial) => [trial.kind, trial.declared.trial_id]),
      [
        ['frozen', CONTROL_TRIAL_ID],
        ['frozen', TREATMENT_TRIAL_ID],
      ],
    );
    for (const trial of evidence.trials) {
      assert.ok(
        trial.kind === 'frozen' && trial.anchor_problems.length === 0 && trial.trial_manifest_sha256 !== undefined,
      );
    }
    assert.deepEqual(
      evidence.trials.map((trial) => (trial.kind === 'frozen' ? trial.oracle_result_ref : undefined)),
      FIXTURE.summary.trial_results.map((entry) => ('oracle_result_ref' in entry ? entry.oracle_result_ref : null)),
      'each trial keeps the path and digest of the stored result it was read from',
    );
  });

  it('reports a summary that names another manifest or variant as drift', () => {
    const summary: ValidationSummary = {
      ...FIXTURE.summary,
      execution_manifest_sha256: digest('other'),
      variant_id: 'conventional',
    };
    const details = driftDetails(evidenceOf(FIXTURE.files, summary));
    assert.equal(details.length, 2);
    assert.match(details[0] ?? '', /the summary names execution_manifest_sha256/);
    assert.match(details[1] ?? '', /the summary names variant conventional, not durable/);
  });

  it('reports a summary entry that is not the declared trial as drift', () => {
    const [control, treatment] = FIXTURE.summary.trial_results;
    const summary: ValidationSummary = { ...FIXTURE.summary, trial_results: [{ ...control, sequence: 2 }, treatment] };
    assert.match(driftDetails(evidenceOf(FIXTURE.files, summary))[0] ?? '', /the summary entry is 2\//);
  });

  it('reads an entry without an oracle result as missing evidence', () => {
    const [control] = FIXTURE.summary.trial_results;
    const unevaluated = {
      sequence: 2,
      trial_id: TREATMENT_TRIAL_ID,
      variant_id: 'durable',
      scenario: 'COMMIT_THEN_TIMEOUT',
      execution_status: 'not_started',
      incompletion_reasons: [{ code: 'NOT_STARTED', subject: 'trial 2', detail: 'never started' }],
    } as const;
    const treatment = treatmentOf(
      evidenceOf(FIXTURE.files, { ...FIXTURE.summary, trial_results: [control, unevaluated] }),
    );
    assert.equal(treatment.kind, 'missing');
    assert.ok(treatment.detail.includes('as not_started without an oracle result'));
  });

  it('reads an unreadable oracle result as missing evidence at its layout path', () => {
    const treatment = treatmentOf(evidenceOf(replaceFile(FIXTURE.files, RESULT_PATH, utf8('{'))));
    assert.ok(treatment.kind === 'missing' && treatment.artifact_path === RESULT_PATH);
  });

  it('reports a summary reference that does not name the stored result', () => {
    const [control, treatment] = FIXTURE.summary.trial_results;
    assert.ok('oracle_result_ref' in treatment);
    const moved = { ...treatment, oracle_result_ref: { ...treatment.oracle_result_ref, artifact_sha256: digest('x') } };
    const evidence = evidenceOf(FIXTURE.files, { ...FIXTURE.summary, trial_results: [control, moved] });
    const read = treatmentOf(evidence);
    assert.equal(read.kind, 'frozen');
    assert.match(read.anchor_problems[0] ?? '', /the summary's oracle_result_ref names/);
    assert.deepEqual(read.oracle_result_ref, treatment.oracle_result_ref, 'the stored result, never the claimed one');
  });

  it('leaves the trial-manifest digest undefined when the trial manifest cannot be read', () => {
    const treatment = treatmentOf(evidenceOf(withoutFile(FIXTURE.files, TRIAL_MANIFEST_PATH)));
    assert.ok(treatment.kind === 'frozen' && treatment.trial_manifest_sha256 === undefined);
  });

  it('reports a trial manifest of another manifest, execution or trial head as drift', () => {
    const edits: readonly [Record<string, unknown>, RegExp][] = [
      [{ execution_manifest_sha256: digest('other') }, /names execution_manifest_sha256/],
      [{ trial_id: CONTROL_TRIAL_ID }, new RegExp(`the trial manifest is 2/${CONTROL_TRIAL_ID}/`)],
    ];
    for (const [change, pattern] of edits) {
      const files = editRecord(FIXTURE.files, TRIAL_MANIFEST_PATH, (record) => ({ ...record, ...change }));
      assert.match(driftDetails(evidenceOf(files))[0] ?? '', pattern);
    }
    const asRun = editRecord(FIXTURE.files, TRIAL_MANIFEST_PATH, ({ variant_validation_id: _id, ...record }) => ({
      ...record,
      run_id: RUN_ID,
      sequence: 4,
    }));
    assert.match(driftDetails(evidenceOf(asRun))[0] ?? '', new RegExp(`belongs to execution run ${RUN_ID}`));
  });

  it('reports an absent or foreign evidence index as a missing anchor', () => {
    assert.match(anchorProblems(withoutFile(FIXTURE.files, INDEX_PATH))[0] ?? '', /evidence-index.json is absent/);
    const controlIndex = FIXTURE.files.find(
      (file) => file.path === PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: CONTROL_TRIAL_ID }, 'evidenceIndex'),
    );
    assert.ok(controlIndex);
    const foreign = replaceFile(FIXTURE.files, INDEX_PATH, controlIndex.bytes);
    assert.match(anchorProblems(foreign)[0] ?? '', /is not the evidence index of trial/);
  });

  it('reports an evidence index that does not list the result, or lists another digest', () => {
    const indexOver = (files: readonly PackageFile[]): Uint8Array =>
      serializeRecordFile(
        unwrap(
          buildEvidenceIndex({
            files,
            target: {
              index_scope: 'TRIAL',
              execution: GOLDEN_IDENTITY as {
                execution_kind: 'VARIANT_VALIDATION';
                variant_validation_id: typeof GOLDEN_VALIDATION_ID;
              },
              trial_id: TREATMENT_TRIAL_ID,
            },
            created_at: goldenAt(5002),
          }),
        ),
      );
    const unlisted = replaceFile(FIXTURE.files, INDEX_PATH, indexOver(withoutFile(FIXTURE.files, RESULT_PATH)));
    assert.match(anchorProblems(unlisted)[0] ?? '', /does not list .*derived\/oracle-result.json; expected it listed/);
    const otherDigest = replaceFile(
      FIXTURE.files,
      INDEX_PATH,
      indexOver(replaceFile(FIXTURE.files, RESULT_PATH, utf8('{}\n'))),
    );
    assert.match(anchorProblems(otherDigest)[0] ?? '', /lists digest [0-9a-f]{64} for/);
  });
});
