// The validation summary (BR-RUA-038; design §6.3, §10.2): both declared trials one to one in
// order, the declared status with its reasons, and the operational fields; a valid catalogue record.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ValidationSummary } from '../../../src/record-contract/records/group-c/validation_summary.ts';
import type { ValidationManifest, ValidationSummaryInput } from '../../../src/variant-validation/validation-summary.ts';
import { buildValidationSummary } from '../../../src/variant-validation/validation-summary.ts';
import { validationReason } from '../../../src/variant-validation/validation-reasons.ts';
import { validationExecutionManifest } from '../../contract/record-contract/group-a/support/manifest-examples.ts';
import { controlFailOracleResult } from '../../contract/record-contract/group-c/examples/oracle-examples.ts';
import { FIXTURE_VALIDATOR } from '../../support/evidence-package/probe-package-fixtures.ts';
import { VALIDATION_ID, at, digest } from '../../support/record-contract/record-builders.ts';
import { toJsonValue } from '../../golden/variant-validation/support/golden-files.ts';
import {
  DECLARED_CONTROL,
  DECLARED_TREATMENT,
  MANIFEST_DIGEST,
  SAFEGUARDS_WITHIN_LIMITS,
  frozen,
  inValidation,
  safetyAssessment,
} from './support/validation-inputs.ts';

const MANIFEST = {
  ...validationExecutionManifest(),
  variant_validation_id: VALIDATION_ID,
  variant_id: 'durable',
  trials: [DECLARED_CONTROL, DECLARED_TREATMENT],
} as ValidationManifest;

function evaluated(
  trial: typeof DECLARED_CONTROL,
  result = frozen(trial).oracle_result,
): ValidationSummaryInput['trials'][0] {
  return {
    kind: 'evaluated',
    execution_status: 'completed',
    incompletion_reasons: [],
    oracle_result: result,
    oracle_result_ref: {
      artifact_path: `trials/${trial.trial_id}/derived/oracle-result.json`,
      artifact_sha256: digest(trial.trial_id),
    },
    trial_manifest_sha256: frozen(trial).trial_manifest_sha256,
    anchor_problems: [],
  };
}

const INPUT: ValidationSummaryInput = {
  manifest: MANIFEST,
  execution_manifest_sha256: MANIFEST_DIGEST,
  trials: [evaluated(DECLARED_CONTROL), evaluated(DECLARED_TREATMENT)],
  scientific_defects: [],
  terminal_reason: 'COMPLETED',
  closure: { cleanup_status: 'succeeded', leak_audit_status: 'clean', lease_status: 'released' },
  safety: safetyAssessment('within_limits', SAFEGUARDS_WITHIN_LIMITS),
  evidence_integrity_status: 'verified',
  late_evidence_status: 'none',
  cleanup_result_ref: { artifact_path: 'cleanup/cleanup-result.json', artifact_sha256: digest('cleanup') },
  late_evidence_assessment_ref: {
    artifact_path: 'late-evidence/late-evidence-assessment.json',
    artifact_sha256: digest('late'),
  },
  created_at: at(9000),
};

function summaryOf(overrides: Partial<ValidationSummaryInput>): ValidationSummary {
  const summary = buildValidationSummary({ ...INPUT, ...overrides });
  const checked = FIXTURE_VALIDATOR.validateAs('validation_summary', toJsonValue(summary));
  assert.equal(checked.valid, true, JSON.stringify(checked.valid ? [] : checked.violations.slice(0, 3)));
  return summary;
}

describe('buildValidationSummary', () => {
  it('summarizes a verified validation with both trials in declared order', () => {
    const summary = summaryOf({});
    assert.equal(summary.implementation_validation_status, 'verified');
    assert.equal(summary.validation_validity, 'valid');
    assert.deepEqual(summary.status_reasons, []);
    assert.deepEqual(
      summary.trial_results.map((entry) => [entry.sequence, entry.trial_id, entry.scenario, entry.execution_status]),
      [
        [1, DECLARED_CONTROL.trial_id, 'CONTROL', 'completed'],
        [2, DECLARED_TREATMENT.trial_id, 'COMMIT_THEN_TIMEOUT', 'completed'],
      ],
    );
    const [control] = summary.trial_results;
    assert.ok('oracle_result_ref' in control);
    assert.equal(control.preservation_verdict, 'pass');
    assert.equal(control.correct_completion, true);
    assert.equal(summary.safety_status, 'within_limits');
    assert.equal('run_id' in summary, false);
  });

  it('summarizes a trustworthy control fail as failed', () => {
    const control = evaluated(DECLARED_CONTROL, inValidation(controlFailOracleResult(), DECLARED_CONTROL));
    const summary = summaryOf({ trials: [control, evaluated(DECLARED_TREATMENT)] });
    assert.equal(summary.implementation_validation_status, 'failed');
    assert.deepEqual(
      summary.status_reasons.map((reason) => reason.code),
      ['CONTROL_PRESERVATION_FAILED'],
    );
  });

  it('summarizes an unevaluated trial as missing evidence, indeterminate', () => {
    const notStarted = {
      kind: 'unevaluated',
      execution_status: 'not_started',
      incompletion_reasons: [{ code: 'NOT_STARTED', subject: 'trial 2', detail: 'the treatment trial never started' }],
    } as const;
    const summary = summaryOf({
      trials: [evaluated(DECLARED_CONTROL), notStarted],
      terminal_reason: 'VALIDATION_INCOMPLETE',
    });
    assert.equal(summary.implementation_validation_status, 'indeterminate');
    assert.equal(summary.validation_validity, 'indeterminate');
    assert.deepEqual(
      summary.status_reasons.map((reason) => reason.code),
      ['SCIENTIFIC_EVIDENCE_MISSING', 'TERMINAL_REASON_NOT_COMPLETED'],
    );
    const [, treatment] = summary.trial_results;
    assert.deepEqual(treatment, {
      ...DECLARED_TREATMENT,
      execution_status: 'not_started',
      incompletion_reasons: notStarted.incompletion_reasons,
    });
  });

  it('judges the declared closure and the scientific defects it is given', () => {
    const defect = validationReason('ADMISSION_INVALID', 'admission', 'revision check failed; expected passed');
    const summary = summaryOf({
      scientific_defects: [defect],
      closure: { cleanup_status: 'partial', leak_audit_status: 'clean', lease_status: 'released' },
      terminal_reason: 'CLEANUP_INCOMPLETE',
    });
    assert.equal(summary.validation_validity, 'invalid');
    assert.deepEqual(
      summary.status_reasons.map((reason) => reason.code),
      ['ADMISSION_INVALID', 'TERMINAL_REASON_NOT_COMPLETED', 'CLEANUP_NOT_SUCCEEDED'],
    );
    assert.equal(summary.cleanup_status, 'partial');
  });
});
