// One execution of the derived Study 1 results (close-out Phase 1): a counted run or validation
// read from its package and verify outputs, and an excluded validation listed with the reasons its
// package states. The reproduction criterion decides both, so neither can be chosen by hand.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { VerificationResult } from '../../../tools/lib/study-results-execution.ts';
import {
  deriveExcludedExecution,
  deriveExecutionResult,
  exactlyOne,
  REPRODUCTION_CRITERION,
} from '../../../tools/lib/study-results-execution.ts';
import {
  editedRun,
  indeterminateValidationInput,
  LIMITATION_9,
  RUN_DIRECTORY,
  runInput,
  summaryEdit,
  VALIDATION_DIRECTORY,
  VALIDATION_SUMMARY,
  validationInput,
  verificationOf,
} from './support/execution-inputs.ts';
import type { EditableRecord, FileMap } from './support/in-memory-evidence.ts';
import {
  COMMIT,
  CONTROL_CONVENTIONAL,
  digestOf,
  firstOf,
  InMemoryEvidence,
  PROBE_ID,
  PROBE_INDEX,
  RUN_ID,
  TIMEOUT_DURABLE,
  VALIDATION_ID,
} from './support/in-memory-evidence.ts';

function deriveVerification(record: EditableRecord): VerificationResult {
  const evidence = new InMemoryEvidence();
  const input = runInput(evidence);
  const file = verificationOf(RUN_ID, {
    ...record,
    original_package_index_sha256: evidence.indexDigest(RUN_DIRECTORY),
    effective_implementation_validation_status: 'verified',
    validation_validity: 'valid',
    package_eligibility: 'eligible',
  });
  const [result] = deriveExecutionResult({ ...input, verifications: [file] }, LIMITATION_9).verifications;
  assert.ok(result);
  return result;
}

describe('deriveExecutionResult', () => {
  it('reads the run: package identity, source, probe, outcome, closure, safety, trials and references', () => {
    const evidence = new InMemoryEvidence();
    const result = deriveExecutionResult(runInput(evidence), LIMITATION_9);
    assert.deepEqual(
      [result.execution_kind, result.execution_id, result.role, result.comparative, result.non_comparative_basis],
      ['run', RUN_ID, 'canonical_run', true, null],
    );
    assert.equal(result.package_directory, RUN_DIRECTORY);
    assert.equal(result.package_index_sha256, evidence.indexDigest(RUN_DIRECTORY));
    assert.equal(result.source_commit, COMMIT);
    assert.deepEqual(result.selected_probe, {
      transport_probe_id: PROBE_ID,
      original_package_index_sha256: PROBE_INDEX,
    });
    assert.deepEqual(result.outcome, {
      run_terminal_reason: 'COMPLETED',
      execution_status: 'completed',
      comparison_eligibility: 'eligible',
    });
    assert.deepEqual(result.closure, {
      cleanup_status: 'succeeded',
      leak_audit_status: 'clean',
      lease_status: 'released',
      safety_status: 'within_limits',
      evidence_integrity_status: 'verified',
    });
    assert.deepEqual(result.safety, {
      safety_status: 'within_limits',
      estimated_cost: { observed_usd: '0.28', declared_limit_usd: '5.00', result: 'within_limits' },
      active_time: { observed_ms: 1131625, declared_limit_ms: 4500000, result: 'within_limits' },
      total_time: { observed_ms: 1512585, declared_limit_ms: 5400000, result: 'within_limits' },
    });
    assert.deepEqual(
      result.trials.map((trial) => [trial.trial_id, trial.preservation_verdict, trial.retry.mechanism]),
      [
        [CONTROL_CONVENTIONAL.id, 'pass', 'none'],
        [TIMEOUT_DURABLE.id, 'fail', 'durable_step_retry'],
      ],
    );
    assert.deepEqual(
      result.evidence_refs.map((ref) => ref.artifact_path),
      [
        'admission/execution-manifest.json',
        'admission/source-provenance.json',
        'summary/run-summary.json',
        'summary/safety-assessment.json',
      ],
    );
  });

  it('counts a verified and valid validation as a non-comparative within-variant reproduction', () => {
    const result = deriveExecutionResult(validationInput(new InMemoryEvidence()), LIMITATION_9);
    assert.deepEqual(
      [result.execution_kind, result.role, result.comparative, result.non_comparative_basis],
      ['variant_validation', 'within_variant_reproduction', false, `Spec limitation 9: ${LIMITATION_9}`],
    );
    assert.deepEqual(result.outcome, {
      validation_terminal_reason: 'COMPLETED',
      implementation_validation_status: 'verified',
      validation_validity: 'valid',
    });
  });

  it('refuses to count a validation that fails the reproduction criterion on either member', () => {
    const subject = `${VALIDATION_DIRECTORY}/${VALIDATION_SUMMARY}`;
    for (const [status, validity] of [
      ['indeterminate', 'valid'],
      ['verified', 'invalid'],
    ] as const) {
      const input = validationInput(new InMemoryEvidence(), undefined, (summary) => {
        summary['implementation_validation_status'] = status;
        summary['validation_validity'] = validity;
      });
      assert.throws(() => deriveExecutionResult(input, LIMITATION_9), {
        message: `${subject}: implementation_validation_status is ${status} and validation_validity is ${validity}; expected verified and valid to count it`,
      });
    }
  });

  it('cites each verify output by digest with the outcome it states', () => {
    const input = runInput(new InMemoryEvidence(), (index) => [
      verificationOf(RUN_ID, {
        record_type: 'package_verification',
        evaluated_at: 't1',
        original_package_index_sha256: index,
        package_eligibility: 'eligible',
      }),
      verificationOf(RUN_ID, {
        record_type: 'study_completion_assessment',
        assessed_at: 't2',
        original_package_index_sha256: index,
        study_completion: 'complete',
        comparison_eligibility: 'eligible',
        package_eligibility: 'eligible',
      }),
    ]);
    const [package_, completion] = deriveExecutionResult(input, LIMITATION_9).verifications;
    assert.deepEqual(package_, {
      path: input.verifications[0]?.path,
      sha256: digestOf(new TextDecoder().decode(input.verifications[0]?.bytes)),
      record_type: 'package_verification',
      recorded_at: 't1',
      outcome: { package_eligibility: 'eligible' },
    });
    assert.deepEqual(completion?.outcome, {
      study_completion: 'complete',
      comparison_eligibility: 'eligible',
      package_eligibility: 'eligible',
    });
    assert.equal(
      deriveVerification({ record_type: 'variant_validation_verification', checked_at: 't3' }).recorded_at,
      't3',
    );
  });

  it('refuses a verify output of an unknown kind or of another package', () => {
    assert.throws(() => deriveVerification({ record_type: 'probe_usability_assessment' }), {
      message: `verifications/${RUN_ID}/2026-10-07T06:00:00.000Z-probe_usability_assessment.json is a probe_usability_assessment; expected one of package_verification, study_completion_assessment, variant_validation_verification`,
    });
    const other = 'f'.repeat(64);
    const evidence = new InMemoryEvidence();
    const input = runInput(evidence, () => [
      verificationOf(RUN_ID, { record_type: 'package_verification', original_package_index_sha256: other }),
    ]);
    assert.throws(() => deriveExecutionResult(input, LIMITATION_9), {
      message: `${input.verifications[0]?.path ?? ''} verifies package ${other}; expected ${RUN_DIRECTORY} at ${evidence.indexDigest(RUN_DIRECTORY)}`,
    });
  });

  it('refuses a summary of another kind or of another execution', () => {
    const subject = `${RUN_DIRECTORY}/summary/run-summary.json`;
    const ofType = summaryEdit((summary) => {
      summary['record_type'] = 'validation_summary';
    });
    assert.throws(() => deriveExecutionResult(editedRun(ofType), LIMITATION_9), {
      message: `${subject} is a validation_summary of ${RUN_ID}; expected the run_summary of ${RUN_ID}`,
    });
    const ofOther = summaryEdit((summary) => {
      summary['run_id'] = VALIDATION_ID;
    });
    assert.throws(() => deriveExecutionResult(editedRun(ofOther), LIMITATION_9), {
      message: `${subject} is a run_summary of ${VALIDATION_ID}; expected the run_summary of ${RUN_ID}`,
    });
  });

  it('refuses a summary whose stated trial verdict differs from the derived one', () => {
    const disagreeing = summaryEdit((summary) => {
      firstOf(summary, 'trial_results')['preservation_verdict'] = 'fail';
    });
    assert.throws(() => deriveExecutionResult(editedRun(disagreeing), LIMITATION_9), {
      message: `${RUN_DIRECTORY} summary trial ${CONTROL_CONVENTIONAL.id} states "CONTROL conventional fail true"; expected the trial's derived "CONTROL conventional pass true"`,
    });
  });

  it('refuses a safety assessment without exactly one check per boundary, or with an unparsable quantity', () => {
    const subject = `${RUN_DIRECTORY}/summary/safety-assessment.json`;
    const safety =
      (checks: readonly EditableRecord[]) =>
      (files: FileMap): void => {
        files.set('summary/safety-assessment.json', { safety_status: 'within_limits', checks });
      };
    const cost = {
      boundary: 'ESTIMATED_COST',
      observed: '0.28 USD',
      declared_limit: '5.00 USD',
      result: 'within_limits',
    };
    const time = (boundary: string, observed: string): EditableRecord => ({
      boundary,
      observed,
      declared_limit: '1 ms',
      result: 'within_limits',
    });
    assert.throws(() => deriveExecutionResult(editedRun(safety([cost, cost])), LIMITATION_9), {
      message: `${subject} holds 2 ESTIMATED_COST checks; expected exactly one`,
    });
    assert.throws(() => deriveExecutionResult(editedRun(safety([cost])), LIMITATION_9), {
      message: `${subject} holds 0 ACTIVE_TIME checks; expected exactly one`,
    });
    assert.throws(() => deriveExecutionResult(editedRun(safety([{ ...cost, observed: '0.28' }])), LIMITATION_9), {
      message: `${subject}: observed is "0.28"; expected a quantity matching /^(\\d+\\.\\d{2}) USD$/`,
    });
    const badTime = [cost, time('ACTIVE_TIME', '1.5 ms'), time('TOTAL_TIME', '1 ms')];
    assert.throws(() => deriveExecutionResult(editedRun(safety(badTime)), LIMITATION_9), {
      message: `${subject}: observed is "1.5 ms"; expected a quantity matching /^(\\d+) ms$/`,
    });
  });
});

describe('deriveExcludedExecution', () => {
  it('lists an indeterminate validation with its criterion, status reasons, gates and reason codes', () => {
    const evidence = new InMemoryEvidence();
    const excluded = deriveExcludedExecution(indeterminateValidationInput(evidence));
    const trialPath = `trials/${TIMEOUT_DURABLE.id}`;
    assert.deepEqual(
      {
        ...excluded,
        trials: excluded.trials.map((trial) => ({
          ...trial,
          evidence_refs: trial.evidence_refs.map((ref) => ref.artifact_path),
        })),
        evidence_refs: excluded.evidence_refs.map((ref) => ref.artifact_path),
      },
      {
        execution_kind: 'variant_validation',
        execution_id: VALIDATION_ID,
        role: 'excluded',
        comparative: false,
        package_directory: VALIDATION_DIRECTORY,
        package_index_sha256: evidence.indexDigest(VALIDATION_DIRECTORY),
        source_commit: COMMIT,
        outcome: {
          validation_terminal_reason: 'COMPLETED',
          implementation_validation_status: 'indeterminate',
          validation_validity: 'indeterminate',
        },
        closure: {
          cleanup_status: 'succeeded',
          leak_audit_status: 'clean',
          lease_status: 'released',
          safety_status: 'within_limits',
          evidence_integrity_status: 'verified',
        },
        verifications: [],
        exclusion: {
          criterion: REPRODUCTION_CRITERION,
          status_reasons: [{ code: 'TRIAL_NOT_VALID', subject: 'trial 1', detail: 'trial_validity is indeterminate' }],
        },
        trials: [
          {
            trial_id: TIMEOUT_DURABLE.id,
            sequence: 2,
            scenario: 'COMMIT_THEN_TIMEOUT',
            variant_id: 'durable',
            preservation_verdict: 'indeterminate',
            trial_validity: 'indeterminate',
            unverified_gates: ['independent_oracle=unverified', 'settlement=invalid'],
            indeterminate_reason_codes: ['INNER_EXECUTION_ACTIVE', 'SETTLEMENT_NOT_ESTABLISHED'],
            evidence_refs: [`${trialPath}/derived/oracle-result.json`, `${trialPath}/trial-manifest.json`],
          },
        ],
        evidence_refs: ['admission/source-provenance.json', VALIDATION_SUMMARY],
      },
    );
  });

  it('refuses to exclude a validation that meets the reproduction criterion', () => {
    assert.throws(() => deriveExcludedExecution(validationInput(new InMemoryEvidence())), {
      message: `${VALIDATION_DIRECTORY}/${VALIDATION_SUMMARY}: implementation_validation_status is verified and validation_validity is valid; expected a validation that fails it`,
    });
  });
});

describe('exactlyOne', () => {
  it('returns the only element and refuses none or several', () => {
    assert.equal(exactlyOne(['a'], 'refused'), 'a');
    assert.throws(() => exactlyOne([], 'refused'), { message: 'refused' });
    assert.throws(() => exactlyOne(['a', 'b'], 'refused'), { message: 'refused' });
  });
});
