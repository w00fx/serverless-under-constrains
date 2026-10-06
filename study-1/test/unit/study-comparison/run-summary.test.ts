// The canonical run summary (CTR-RUA-002, AC-RUA-012): exactly four entries in declared order, each
// a copy of its oracle result's verdict and completion, or the reason it has none (D-29); the
// operational statuses are separate fields and nothing aggregates the verdicts.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { buildRunSummary } from '../../../src/study-comparison/run-summary.ts';
import type { RunSummaryInput } from '../../../src/study-comparison/run-summary.ts';
import { assertSchemaValid } from '../../golden/study-comparison/support/golden-views.ts';
import { cleanRunRecords, trialFile } from './support/clean-run.ts';
import { editResult, resultsOf } from './support/frozen-results.ts';

let input: RunSummaryInput;

before(async () => {
  const records = await cleanRunRecords();
  const { cleanup, late_evidence: late } = records;
  assert.ok(cleanup !== undefined && late !== undefined);
  const trials = records.execution_manifest.record.trials;
  input = {
    run_id: records.run_id,
    execution_manifest_sha256: records.execution_manifest.ref.artifact_sha256,
    trials,
    started_trials: new Set(trials.map((trial) => trial.trial_id)),
    oracle_results: resultsOf(records),
    run_terminal_reason: 'COMPLETED',
    comparison: { comparison_eligibility: 'eligible', comparison_ineligibility_reasons: [] },
    comparison_assessment_ref: {
      artifact_path: 'summary/comparison-assessment.json',
      artifact_sha256: late.ref.artifact_sha256,
    },
    cleanup,
    leak_audit_status: 'clean',
    lease_status: 'released',
    safety_status: 'within_limits',
    evidence_integrity_status: 'verified',
    late_evidence_assessment_ref: late.ref,
    created_at: '2026-10-05T13:15:00.000Z' as UtcMillis,
  };
});

describe('buildRunSummary', () => {
  it('copies each verdict and completion verbatim, in declared order', () => {
    const summary = buildRunSummary(input);
    assertSchemaValid('run_summary', summary);
    assert.equal(summary.execution_status, 'completed');
    assert.deepEqual(
      summary.trial_results.map((entry) => [entry.sequence, entry.trial_id, entry.variant_id, entry.scenario]),
      input.trials.map((trial) => [trial.sequence, trial.trial_id, trial.variant_id, trial.scenario]),
    );
    for (const entry of summary.trial_results) {
      const result = input.oracle_results.get(entry.trial_id);
      assert.ok('oracle_result_ref' in entry);
      assert.deepEqual(
        [
          entry.execution_status,
          entry.oracle_result_ref,
          entry.preservation_verdict,
          entry.correct_completion,
          entry.incompletion_reasons,
        ],
        ['completed', result?.ref, result?.record.preservation_verdict, result?.record.correct_completion, []],
      );
    }
  });

  it('carries the operational statuses and references as separate fields', () => {
    const summary = buildRunSummary({ ...input, lease_status: 'recovery_required', safety_status: 'breached' });
    assert.equal(summary.cleanup_status, input.cleanup.record.cleanup_status);
    assert.deepEqual(summary.cleanup_result_ref, input.cleanup.ref);
    assert.equal(summary.lease_status, 'recovery_required');
    assert.equal(summary.safety_status, 'breached');
    assert.deepEqual(summary.comparison_assessment_ref, input.comparison_assessment_ref);
    assert.deepEqual(summary.late_evidence_assessment_ref, input.late_evidence_assessment_ref);
  });

  it('reports a started trial without a result as TRIAL_NOT_FROZEN and the run incomplete', () => {
    const trial = input.trials[2];
    const summary = buildRunSummary({
      ...input,
      oracle_results: editResult(input.oracle_results, trial.trial_id, null),
      run_terminal_reason: 'TRIAL_INCOMPLETE',
      comparison: {
        comparison_eligibility: 'ineligible',
        comparison_ineligibility_reasons: [
          { code: 'ORACLE_RESULT_MISSING', subject: trial.trial_id, detail: 'absent' },
        ],
      },
    });
    assertSchemaValid('run_summary', summary);
    assert.equal(summary.execution_status, 'incomplete');
    const entry = summary.trial_results[2];
    assert.equal(entry.execution_status, 'incomplete');
    assert.ok(!('oracle_result_ref' in entry));
    assert.deepEqual(
      entry.incompletion_reasons.map(({ code, subject, artifact_path }) => [code, subject, artifact_path]),
      [['TRIAL_NOT_FROZEN', trial.trial_id, trialFile(trial.trial_id, 'oracleResult')]],
    );
  });

  it('reports a trial that never started as TRIAL_NOT_STARTED', () => {
    const trial = input.trials[3];
    const summary = buildRunSummary({
      ...input,
      started_trials: new Set(input.trials.slice(0, 3).map((entry) => entry.trial_id)),
      oracle_results: editResult(input.oracle_results, trial.trial_id, null),
      run_terminal_reason: 'TRIAL_INCOMPLETE',
      comparison: {
        comparison_eligibility: 'ineligible',
        comparison_ineligibility_reasons: [
          { code: 'ORACLE_RESULT_MISSING', subject: trial.trial_id, detail: 'absent' },
        ],
      },
    });
    assertSchemaValid('run_summary', summary);
    const entry = summary.trial_results[3];
    assert.equal(entry.execution_status, 'not_started');
    assert.deepEqual(
      entry.incompletion_reasons.map(({ code, artifact_path }) => [code, artifact_path]),
      [['TRIAL_NOT_STARTED', trialFile(trial.trial_id, 'trialManifest')]],
    );
    assert.equal(summary.comparison_eligibility, 'ineligible');
    assert.equal(summary.comparison_ineligibility_reasons.length, 1);
  });
});
