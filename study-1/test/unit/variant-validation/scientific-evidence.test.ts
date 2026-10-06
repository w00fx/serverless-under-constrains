// The scientific acceptance conditions of a validation's original evidence (BR-RUA-038, design
// §8.15): missing evidence, manifest drift, missing anchors, non-valid trials, control integrity,
// treatment fidelity and indeterminate verdicts, and how they fold into the validation validity.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OracleResult } from '../../../src/record-contract/records/group-c/oracle_result.ts';
import { assessScientificEvidence } from '../../../src/variant-validation/scientific-evidence.ts';
import type { TrialEvidence } from '../../../src/variant-validation/scientific-evidence.ts';
import { validationReason } from '../../../src/variant-validation/validation-reasons.ts';
import {
  controlFailOracleResult,
  invalidTreatmentOracleResult,
  validIndeterminateOracleResult,
} from '../../contract/record-contract/group-c/examples/oracle-examples.ts';
import { RUN_ID, digest, uuid } from '../../support/record-contract/record-builders.ts';
import {
  DECLARED_CONTROL,
  DECLARED_TREATMENT,
  frozen,
  inValidation,
  scientificEvidence,
} from './support/validation-inputs.ts';

function assess(control: TrialEvidence, treatment: TrialEvidence): ReturnType<typeof assessScientificEvidence> {
  return assessScientificEvidence(scientificEvidence({ trials: [control, treatment] }));
}

function codes(control: TrialEvidence, treatment: TrialEvidence): readonly string[] {
  return assess(control, treatment).reasons.map((reason) => reason.code);
}

function withResult(
  base: ReturnType<typeof frozen>,
  changes: Partial<Record<keyof OracleResult, unknown>>,
): TrialEvidence {
  return { ...base, oracle_result: { ...base.oracle_result, ...changes } as OracleResult };
}

const CONTROL = frozen(DECLARED_CONTROL);
const TREATMENT = frozen(DECLARED_TREATMENT);

describe('assessScientificEvidence', () => {
  it('is valid with no reason and both verdicts for two sound trials', () => {
    assert.deepEqual(assess(CONTROL, TREATMENT), {
      validation_validity: 'valid',
      reasons: [],
      control_verdict: 'pass',
      treatment_verdict: 'pass',
    });
  });

  it('reports a missing trial as missing scientific evidence, indeterminate, with no verdict', () => {
    const missing: TrialEvidence = {
      kind: 'missing',
      declared: DECLARED_TREATMENT,
      artifact_path: `trials/${DECLARED_TREATMENT.trial_id}/derived/oracle-result.json`,
      detail: 'absent; expected a frozen oracle result',
    };
    const assessment = assess(CONTROL, missing);
    assert.equal(assessment.validation_validity, 'indeterminate');
    assert.equal(assessment.treatment_verdict, undefined);
    assert.deepEqual(assessment.reasons, [
      validationReason(
        'SCIENTIFIC_EVIDENCE_MISSING',
        'trial 2 (COMMIT_THEN_TIMEOUT)',
        missing.detail,
        missing.artifact_path,
      ),
    ]);
  });

  it('reports a missing trial manifest as missing scientific evidence', () => {
    const assessment = assess({ ...CONTROL, trial_manifest_sha256: undefined }, TREATMENT);
    assert.equal(assessment.validation_validity, 'indeterminate');
    assert.deepEqual(
      assessment.reasons.map((reason) => reason.code),
      ['SCIENTIFIC_EVIDENCE_MISSING'],
    );
  });

  it('reports a missing anchor per problem, indeterminate', () => {
    const assessment = assess(CONTROL, { ...TREATMENT, anchor_problems: ['no evidence index', 'digest differs'] });
    assert.equal(assessment.validation_validity, 'indeterminate');
    assert.deepEqual(
      assessment.reasons.map((reason) => reason.detail),
      ['no evidence index', 'digest differs'],
    );
  });

  it('reports every kind of manifest drift as invalid', () => {
    const drifted: readonly TrialEvidence[] = [
      withResult(TREATMENT, { execution_manifest_sha256: digest('another manifest') }),
      withResult(TREATMENT, { variant_validation_id: uuid(0x1999) }),
      withResult(TREATMENT, { trial_id: DECLARED_CONTROL.trial_id }),
      withResult(TREATMENT, { variant_id: 'conventional' }),
      withResult(TREATMENT, { scenario: 'CONTROL' }),
      withResult(TREATMENT, { trial_manifest_sha256: digest('another trial manifest') }),
    ];
    for (const treatment of drifted) {
      const assessment = assess(CONTROL, treatment);
      assert.equal(assessment.validation_validity, 'invalid');
      assert.ok(assessment.reasons.some((reason) => reason.code === 'MANIFEST_DRIFT'));
    }
  });

  it('names a run identity when a result belongs to a run', () => {
    const { variant_validation_id: _validationId, ...asRun } = TREATMENT.oracle_result;
    const runResult = { ...asRun, run_id: RUN_ID } as OracleResult;
    const assessment = assess(CONTROL, { ...TREATMENT, oracle_result: runResult });
    assert.match(assessment.reasons[0]?.detail ?? '', new RegExp(`names execution run ${RUN_ID}`));
  });

  it('does not report trial-manifest drift when the trial manifest is missing', () => {
    const treatment = withResult(
      { ...TREATMENT, trial_manifest_sha256: undefined },
      { trial_manifest_sha256: digest('other') },
    );
    assert.deepEqual(codes(CONTROL, treatment), ['SCIENTIFIC_EVIDENCE_MISSING']);
  });

  it('reports a non-valid trial, unverified treatment fidelity and an indeterminate treatment verdict', () => {
    const invalid = frozen(DECLARED_TREATMENT, {
      oracle_result: inValidation(invalidTreatmentOracleResult(), DECLARED_TREATMENT),
    });
    const assessment = assess(CONTROL, invalid);
    assert.equal(assessment.validation_validity, 'invalid');
    assert.deepEqual(
      assessment.reasons.map((reason) => reason.code),
      ['TRIAL_NOT_VALID', 'TREATMENT_FIDELITY_NOT_VERIFIED', 'TREATMENT_VERDICT_INDETERMINATE'],
    );
  });

  it('reports a valid treatment trial with an indeterminate verdict, still valid', () => {
    const indeterminate = frozen(DECLARED_TREATMENT, {
      oracle_result: inValidation(validIndeterminateOracleResult(), DECLARED_TREATMENT),
    });
    const assessment = assess(CONTROL, indeterminate);
    assert.equal(assessment.validation_validity, 'valid');
    assert.equal(assessment.treatment_verdict, 'indeterminate');
    assert.deepEqual(
      assessment.reasons.map((reason) => reason.code),
      ['TREATMENT_VERDICT_INDETERMINATE'],
    );
  });

  it('reports control integrity other than verified and an indeterminate control verdict', () => {
    const control = withResult(CONTROL, { control_integrity: 'unverified', preservation_verdict: 'indeterminate' });
    assert.deepEqual(codes(control, TREATMENT), ['CONTROL_INTEGRITY_NOT_VERIFIED', 'CONTROL_VERDICT_INDETERMINATE']);
  });

  it('passes a trustworthy control fail through as a verdict, not a reason', () => {
    const control = frozen(DECLARED_CONTROL, {
      oracle_result: inValidation(controlFailOracleResult(), DECLARED_CONTROL),
    });
    const assessment = assess(control, TREATMENT);
    assert.deepEqual(assessment.reasons, []);
    assert.equal(assessment.control_verdict, 'fail');
  });

  it('folds an indeterminate trial validity, and lets invalid outrank indeterminate', () => {
    assert.equal(
      assess(withResult(CONTROL, { trial_validity: 'indeterminate' }), TREATMENT).validation_validity,
      'indeterminate',
    );
    const mixed = assess(
      withResult(CONTROL, { trial_validity: 'indeterminate' }),
      withResult(TREATMENT, { trial_validity: 'invalid' }),
    );
    assert.equal(mixed.validation_validity, 'invalid');
  });

  it('puts the evidence defects first and folds them into the validity', () => {
    const admission = validationReason('ADMISSION_INVALID', 'admission', 'revision check failed; expected passed');
    const assessment = assessScientificEvidence(scientificEvidence({ defects: [admission] }));
    assert.equal(assessment.validation_validity, 'invalid');
    assert.deepEqual(assessment.reasons, [admission]);
  });
});
