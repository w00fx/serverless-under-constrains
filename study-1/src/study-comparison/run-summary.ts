// The canonical run summary (CTR-RUA-002; design §6.3, §8.14; AC-RUA-012). It has exactly four trial
// results, mapped one to one from the manifest's declared trials in declared order: never filtered,
// reordered, or annotated with the hypothesis. A trial with an oracle result is reported with that
// result's verdict and completion copied verbatim, whatever they are; a trial without one is
// reported with why (D-29). The operational statuses are separate fields, and the summary has no
// winner, aggregate, ranking or statistic.

import type { Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../record-contract/primitives.ts';
import type { DeclaredTrial } from '../record-contract/records/group-a/execution_manifest.ts';
import type { SafetyResult } from '../record-contract/records/group-b/vocabulary.ts';
import type { CleanupResult } from '../record-contract/records/group-c/cleanup_result.ts';
import type { ComparisonEligibilityOutcome, RunSummary } from '../record-contract/records/group-c/run_summary.ts';
import type { ArtifactRef, SummaryTrialResult } from '../record-contract/records/group-c/shared-shapes.ts';
import type {
  ApplicableGateValue,
  LeakAuditStatus,
  LeaseStatus,
  RunTerminalReason,
} from '../record-contract/records/group-c/vocabulary.ts';
import { PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { eligibilityOutcome } from './comparison-assessment.ts';
import { comparisonReason } from './comparison-reasons.ts';
import type { FrozenRecord } from './record-files.ts';
import type { OracleResultsByTrial } from './run-evidence-integrity.ts';

/** The canonical run's four declared trials, in declared order (BR-RUA-019). */
export type FourDeclaredTrials = readonly [DeclaredTrial, DeclaredTrial, DeclaredTrial, DeclaredTrial];

/** Everything the summary reports (design §5.3 `RunSummaryInput`). */
export interface RunSummaryInput {
  readonly run_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly trials: FourDeclaredTrials;
  /** Trials whose trial manifest was frozen, so they started (BR-RUA-040). */
  readonly started_trials: ReadonlySet<Uuid4>;
  readonly oracle_results: OracleResultsByTrial;
  readonly run_terminal_reason: RunTerminalReason;
  readonly comparison: ComparisonEligibilityOutcome;
  readonly comparison_assessment_ref: ArtifactRef;
  readonly cleanup: FrozenRecord<CleanupResult>;
  readonly leak_audit_status: LeakAuditStatus;
  readonly lease_status: LeaseStatus;
  readonly safety_status: SafetyResult;
  readonly evidence_integrity_status: ApplicableGateValue;
  readonly late_evidence_assessment_ref: ArtifactRef;
  readonly created_at: UtcMillis;
}

/**
 * Builds the run summary: exactly four entries in declared order.
 *
 * @example
 * const summary = buildRunSummary({ run_id, execution_manifest_sha256, trials, started_trials, oracle_results,
 *   run_terminal_reason, comparison, comparison_assessment_ref, cleanup, leak_audit_status, lease_status,
 *   safety_status, evidence_integrity_status, late_evidence_assessment_ref, created_at });
 * summary.trial_results.map((entry) => entry.trial_id); // the manifest's trial ids, in order
 */
export function buildRunSummary(input: RunSummaryInput): RunSummary {
  const entry = (trial: DeclaredTrial): SummaryTrialResult => trialEntry(trial, input);
  const [first, second, third, fourth] = input.trials;
  const trialResults = [entry(first), entry(second), entry(third), entry(fourth)] as const;
  return {
    schema_version: 1,
    record_type: 'run_summary',
    run_id: input.run_id,
    execution_manifest_sha256: input.execution_manifest_sha256,
    trial_results: trialResults,
    execution_status: trialResults.every((result) => result.execution_status === 'completed')
      ? 'completed'
      : 'incomplete',
    run_terminal_reason: input.run_terminal_reason,
    ...eligibilityOutcome(input.comparison),
    cleanup_status: input.cleanup.record.cleanup_status,
    leak_audit_status: input.leak_audit_status,
    lease_status: input.lease_status,
    safety_status: input.safety_status,
    evidence_integrity_status: input.evidence_integrity_status,
    cleanup_result_ref: input.cleanup.ref,
    late_evidence_assessment_ref: input.late_evidence_assessment_ref,
    comparison_assessment_ref: input.comparison_assessment_ref,
    created_at: input.created_at,
  };
}

function trialEntry(trial: DeclaredTrial, input: RunSummaryInput): SummaryTrialResult {
  const head = {
    sequence: trial.sequence,
    trial_id: trial.trial_id,
    variant_id: trial.variant_id,
    scenario: trial.scenario,
  };
  const result = input.oracle_results.get(trial.trial_id);
  if (result !== undefined) {
    return {
      ...head,
      execution_status: 'completed',
      oracle_result_ref: result.ref,
      preservation_verdict: result.record.preservation_verdict,
      correct_completion: result.record.correct_completion,
      incompletion_reasons: [],
    };
  }
  return input.started_trials.has(trial.trial_id)
    ? { ...head, execution_status: 'incomplete', incompletion_reasons: [notFrozen(trial)] }
    : { ...head, execution_status: 'not_started', incompletion_reasons: [notStarted(trial)] };
}

function notFrozen(trial: DeclaredTrial): StructuredReason {
  const path = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trial.trial_id }, 'oracleResult');
  return comparisonReason(
    'TRIAL_NOT_FROZEN',
    trial.trial_id,
    `trial ${trial.trial_id} started but ${path} is absent; expected a frozen oracle result`,
    path,
  );
}

function notStarted(trial: DeclaredTrial): StructuredReason {
  const path = PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trial.trial_id }, 'trialManifest');
  return comparisonReason(
    'TRIAL_NOT_STARTED',
    trial.trial_id,
    `trial ${trial.trial_id} has no frozen ${path}; expected the trial to have started`,
    path,
  );
}
