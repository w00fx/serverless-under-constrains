// The two package-level compositions: run finalization (design §10.2 P9) derives the comparison
// assessment and the run summary from the frozen records and returns the bytes to store once; study
// completion reads the original package only.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import {
  assessPackageCompletion,
  finalizeRunAssessments,
} from '../../../src/study-comparison/run-package-assessment.ts';
import type {
  FinalizedRunFiles,
  RunFinalizationContext,
} from '../../../src/study-comparison/run-package-assessment.ts';
import type { RunPackageRecords } from '../../../src/study-comparison/run-package-reader.ts';
import {
  sealGoldenRun,
  specDeploymentProjection,
  verifyGoldenRun,
} from '../../golden/study-comparison/support/golden-run.ts';
import { assertSchemaValid } from '../../golden/study-comparison/support/golden-views.ts';
import { BASE_QUALIFICATION } from '../../golden/study-comparison/support/run-fixture.ts';
import { cleanRunFiles, cleanRunRecords } from './support/clean-run.ts';

const FINALIZED_AT = '2026-10-05T13:15:00.000Z' as UtcMillis;
let records: RunPackageRecords;
let context: RunFinalizationContext;

before(async () => {
  records = await cleanRunRecords();
  context = {
    deployment: specDeploymentProjection(records.execution_manifest.ref.artifact_sha256),
    contradictory_amendments: [],
    finalized_at: FINALIZED_AT,
  };
});

function finalize(input: RunPackageRecords, finalization: RunFinalizationContext = context): FinalizedRunFiles {
  const result = finalizeRunAssessments(input, finalization, sha256Hex);
  assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.error));
  assertSchemaValid('comparison_assessment', result.value.comparison_assessment.record);
  assertSchemaValid('run_summary', result.value.run_summary.record);
  return result.value;
}

describe('finalizeRunAssessments', () => {
  it('returns both summary files with canonical bytes and the summary citing the assessment bytes', () => {
    const finalized = finalize(records);
    const { comparison_assessment: comparison, run_summary: summary } = finalized;
    assert.equal(comparison.path, EXECUTION_PATHS.comparisonAssessment);
    assert.equal(summary.path, EXECUTION_PATHS.runSummary);
    assert.deepEqual(comparison.bytes, serializeRecordFile(comparison.record));
    assert.deepEqual(summary.bytes, serializeRecordFile(summary.record));
    assert.deepEqual(summary.record.comparison_assessment_ref, {
      artifact_path: comparison.path,
      artifact_sha256: sha256Hex(comparison.bytes),
    });
    assert.deepEqual(summary.record.cleanup_result_ref, records.cleanup?.ref);
    assert.deepEqual(summary.record.late_evidence_assessment_ref, records.late_evidence?.ref);
    assert.deepEqual(
      [
        summary.record.run_terminal_reason,
        summary.record.lease_status,
        summary.record.safety_status,
        summary.record.evidence_integrity_status,
      ],
      ['COMPLETED', 'released', 'within_limits', 'verified'],
    );
    assert.equal(summary.record.created_at, FINALIZED_AT);
  });

  it('fails naming both inputs the summary must cite when they are absent', () => {
    const result = finalizeRunAssessments(
      { ...records, cleanup: undefined, late_evidence: undefined },
      context,
      sha256Hex,
    );
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.error.map((reason) => reason.artifact_path),
      [EXECUTION_PATHS.cleanupResult, EXECUTION_PATHS.lateEvidenceAssessment],
    );
    const lateOnly = finalizeRunAssessments({ ...records, late_evidence: undefined }, context, sha256Hex);
    assert.deepEqual(lateOnly.ok ? [] : lateOnly.error.map((reason) => reason.artifact_path), [
      EXECUTION_PATHS.lateEvidenceAssessment,
    ]);
    const cleanupOnly = finalizeRunAssessments({ ...records, cleanup: undefined }, context, sha256Hex);
    assert.deepEqual(cleanupOnly.ok ? [] : cleanupOnly.error.map((reason) => reason.artifact_path), [
      EXECUTION_PATHS.cleanupResult,
    ]);
  });

  it('reports an unverified safety status and inconclusive audit when those records are absent', () => {
    const summary = finalize({ ...records, safety: undefined, leak_audit: undefined }).run_summary.record;
    assert.equal(summary.safety_status, 'unverified');
    assert.equal(summary.leak_audit_status, 'inconclusive');
    assert.equal(summary.run_terminal_reason, 'LEAK_AUDIT_NOT_CLEAN');
    assert.equal(summary.comparison_eligibility, 'ineligible');
  });

  it('makes the template projections indeterminate without a deployment projection', () => {
    const comparison = finalize(records, { ...context, deployment: undefined }).comparison_assessment.record;
    assert.equal(comparison.equality_result, 'indeterminate');
    assert.equal(comparison.comparison_eligibility, 'ineligible');
  });

  it('reports a trial without a trial manifest or result as not started', () => {
    const [first, second, third, fourth] = records.trial_records;
    const unstarted = { ...fourth, trial_manifest: undefined, oracle_result: undefined };
    const summary = finalize({ ...records, trial_records: [first, second, third, unstarted] }).run_summary.record;
    assert.equal(summary.trial_results[3].execution_status, 'not_started');
    assert.equal(summary.run_terminal_reason, 'TRIAL_INCOMPLETE');
  });

  it('passes the contradictory amendments to eligibility', () => {
    const reason = { code: 'CONTRADICTORY_CHAIN', subject: 'BR-RUA-043', detail: 'disagree' };
    const comparison = finalize(records, { ...context, contradictory_amendments: [reason] }).comparison_assessment
      .record;
    assert.deepEqual(
      comparison.comparison_ineligibility_reasons.map((entry) => entry.code),
      ['CONTRADICTORY_AMENDMENT'],
    );
  });
});

describe('assessPackageCompletion', () => {
  it('assesses completion from the original package records', async () => {
    const sealed = sealGoldenRun(await cleanRunFiles());
    const completion = assessPackageCompletion(records, {
      original_package_index_sha256: sealed.package_index_sha256,
      package_verification: verifyGoldenRun(sealed.files, [], null),
      billed_cost_checks: [],
      selected_qualification: BASE_QUALIFICATION,
      assessed_at: FINALIZED_AT,
    });
    assertSchemaValid('study_completion_assessment', completion);
    assert.equal(completion.study_completion, 'complete');
    assert.equal(completion.run_id, records.run_id);
  });
});
