// The two package-level compositions of this feature. Run finalization (design §10.2 P9 SUMMARY)
// derives the comparison assessment and the run summary from the frozen records of a run package;
// the caller writes the returned bytes once. Study completion (BR-RUA-054) is derived later by a
// verifier from the same original package and that package's verification.

import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import type { Sha256Hex, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result } from '../record-contract/primitives.ts';
import type { ComparisonAssessment } from '../record-contract/records/group-c/comparison_assessment.ts';
import type { PackageVerification } from '../record-contract/records/group-c/package_verification.ts';
import type { RunSummary } from '../record-contract/records/group-c/run_summary.ts';
import type { StudyCompletionAssessment } from '../record-contract/records/group-c/study_completion_assessment.ts';
import type { BilledCostCheck } from '../record-contract/records/group-c/vocabulary.ts';
import type { ByteDigest } from '../evidence-package/package-integrity.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { assessRunComparison } from './comparison-assessment.ts';
import { comparisonReason } from './comparison-reasons.ts';
import { buildTrialSheets } from './equality-sheets.ts';
import type { DeploymentProjection } from './equality-sheets.ts';
import type { RunPackageRecords } from './run-package-reader.ts';
import { buildRunSummary } from './run-summary.ts';
import type { FourDeclaredTrials } from './run-summary.ts';
import { deriveRunTerminalReason, finalLeaseStatus } from './run-terminal-reason.ts';
import { assessStudyCompletion } from './study-completion.ts';
import type { SelectedRunQualification } from './study-provenance.ts';
import type { OracleResultsByTrial } from './run-evidence-integrity.ts';

/** What finalization reads besides the package. */
export interface RunFinalizationContext {
  /** The inventoried template's projection (equality-sheets.ts); absent makes its projections indeterminate. */
  readonly deployment: DeploymentProjection | undefined;
  /** Empty when finalizing the original package, which has no amendment yet. */
  readonly contradictory_amendments: readonly StructuredReason[];
  readonly finalized_at: UtcMillis;
}

/** A record and the exact bytes to store for it. */
export interface FinalizedRecordFile<T> {
  readonly path: string;
  readonly record: T;
  readonly bytes: Uint8Array;
}

/** The two summary files of a finalized run. */
export interface FinalizedRunFiles {
  readonly comparison_assessment: FinalizedRecordFile<ComparisonAssessment>;
  readonly run_summary: FinalizedRecordFile<RunSummary>;
}

/**
 * Derives `summary/comparison-assessment.json` and `summary/run-summary.json`. Fails when the
 * cleanup result or the late-evidence assessment is absent, because the summary must cite both
 * (CTR-RUA-002 `cleanup_result_ref`, `late_evidence_assessment_ref`).
 *
 * @example
 * const finalized = finalizeRunAssessments(records, { deployment, contradictory_amendments: [], finalized_at }, sha256Hex);
 * if (finalized.ok) await store.writeOnce(finalized.value.run_summary.path, finalized.value.run_summary.bytes);
 */
export function finalizeRunAssessments(
  records: RunPackageRecords,
  context: RunFinalizationContext,
  digest: ByteDigest,
): Result<FinalizedRunFiles, readonly StructuredReason[]> {
  const { cleanup, late_evidence: late } = records;
  if (cleanup === undefined || late === undefined) {
    return err([
      ...(cleanup === undefined ? [summaryInputMissing(EXECUTION_PATHS.cleanupResult)] : []),
      ...(late === undefined ? [summaryInputMissing(EXECUTION_PATHS.lateEvidenceAssessment)] : []),
    ]);
  }
  const manifest = records.execution_manifest;
  const oracleResults = oracleResultsOf(records);
  const comparison = assessRunComparison({
    run_id: records.run_id,
    execution_manifest_sha256: manifest.ref.artifact_sha256,
    trials: manifest.record.trials,
    declared_variant_differences: manifest.record.declared_variant_differences,
    trial_inputs: records.trial_records.map((trial) =>
      buildTrialSheets({
        trial: trial.trial,
        execution_manifest: manifest,
        resource_manifest: records.resource_manifest,
        provider_configuration: trial.provider_configuration,
        payment: trial.payment,
        approved_decision: trial.approved_decision,
        deployment: context.deployment,
      }),
    ),
    oracle_results: oracleResults,
    late_evidence: late,
    leak_audit: records.leak_audit,
    contradictory_amendments: context.contradictory_amendments,
    assessed_at: context.finalized_at,
  });
  const comparisonFile = recordFile(EXECUTION_PATHS.comparisonAssessment, comparison.assessment);
  const trials: FourDeclaredTrials = manifest.record.trials;
  const summary = buildRunSummary({
    run_id: records.run_id,
    execution_manifest_sha256: manifest.ref.artifact_sha256,
    trials,
    started_trials: new Set(
      records.trial_records.flatMap((trial) => (trial.trial_manifest === undefined ? [] : [trial.trial.trial_id])),
    ),
    oracle_results: oracleResults,
    run_terminal_reason: deriveRunTerminalReason({
      events: [...records.runner_events, ...records.lease_events],
      all_trials_frozen: oracleResults.size === trials.length,
      cleanup_status: cleanup.record.cleanup_status,
      leak_audit_status: records.leak_audit?.record.leak_audit_status,
    }),
    comparison: comparison.assessment,
    comparison_assessment_ref: { artifact_path: comparisonFile.path, artifact_sha256: digest(comparisonFile.bytes) },
    cleanup,
    leak_audit_status: records.leak_audit?.record.leak_audit_status ?? 'inconclusive',
    lease_status: finalLeaseStatus(records.lease_events),
    safety_status: records.safety?.record.safety_status ?? 'unverified',
    evidence_integrity_status: comparison.evidence_integrity.status,
    late_evidence_assessment_ref: late.ref,
    created_at: context.finalized_at,
  });
  return ok({ comparison_assessment: comparisonFile, run_summary: recordFile(EXECUTION_PATHS.runSummary, summary) });
}

/** What the completion verifier reads besides the original package. */
export interface CompletionContext {
  readonly original_package_index_sha256: Sha256Hex;
  readonly package_verification: PackageVerification;
  readonly billed_cost_checks: readonly BilledCostCheck[];
  readonly selected_qualification: SelectedRunQualification | undefined;
  readonly assessed_at: UtcMillis;
}

/**
 * Assesses BR-RUA-054 from the original package's records; amendments are never read here.
 *
 * @example
 * assessPackageCompletion(records, { original_package_index_sha256, package_verification,
 *   billed_cost_checks: [], selected_qualification, assessed_at }).study_completion;
 */
export function assessPackageCompletion(
  records: RunPackageRecords,
  context: CompletionContext,
): StudyCompletionAssessment {
  return assessStudyCompletion({
    run_id: records.run_id,
    original_package_index_sha256: context.original_package_index_sha256,
    package_verification: context.package_verification,
    execution_manifest: records.execution_manifest,
    run_summary: records.run_summary,
    comparison_assessment: records.comparison_assessment,
    leak_audit: records.leak_audit,
    source_provenance: records.source_provenance,
    billed_cost_checks: context.billed_cost_checks,
    selected_qualification: context.selected_qualification,
    assessed_at: context.assessed_at,
  });
}

function oracleResultsOf(records: RunPackageRecords): OracleResultsByTrial {
  return new Map(
    records.trial_records.flatMap((trial) =>
      trial.oracle_result === undefined ? [] : [[trial.trial.trial_id, trial.oracle_result] as const],
    ),
  );
}

function recordFile<T extends ComparisonAssessment | RunSummary>(path: string, record: T): FinalizedRecordFile<T> {
  return { path, record, bytes: serializeRecordFile(record) };
}

function summaryInputMissing(path: string): StructuredReason {
  return comparisonReason(
    'ARTIFACT_MISSING',
    'run_summary',
    `${path} is absent or unreadable; expected it frozen before the run summary`,
    path,
  );
}
