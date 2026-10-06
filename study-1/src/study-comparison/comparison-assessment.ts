// The `comparison_assessment` record of a canonical run (design §6.2 row 73, §8.14): the eight
// BR-RUA-007 equality projections and the nine eligibility conditions, frozen once in
// `summary/comparison-assessment.json`. The record cites the oracle results it read, in declared
// trial order; it never copies a verdict.

import type { Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../record-contract/primitives.ts';
import type {
  DeclaredTrial,
  DeclaredVariantDifference,
} from '../record-contract/records/group-a/execution_manifest.ts';
import type { ComparisonAssessment } from '../record-contract/records/group-c/comparison_assessment.ts';
import type { LateEvidenceAssessment } from '../record-contract/records/group-c/late_evidence_assessment.ts';
import type { LeakAuditResult } from '../record-contract/records/group-c/leak_audit_result.ts';
import type { ComparisonEligibilityOutcome } from '../record-contract/records/group-c/run_summary.ts';
import type { ArtifactRef } from '../record-contract/records/group-c/shared-shapes.ts';
import { deriveComparisonEligibility } from './comparison-eligibility.ts';
import { evaluateEquality } from './equality-evaluation.ts';
import type { ComparisonTrialInputs } from './equality-sheets.ts';
import type { FrozenRecord } from './record-files.ts';
import { deriveRunEvidenceIntegrity } from './run-evidence-integrity.ts';
import type { OracleResultsByTrial, RunEvidenceIntegrity } from './run-evidence-integrity.ts';

/** What one run's comparison reads. */
export interface RunComparisonInput {
  readonly run_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  /** The manifest's four declared trials, in declared order. */
  readonly trials: readonly DeclaredTrial[];
  readonly declared_variant_differences: readonly DeclaredVariantDifference[];
  /** The equality inputs of each declared trial (`buildTrialSheets`). */
  readonly trial_inputs: readonly ComparisonTrialInputs[];
  readonly oracle_results: OracleResultsByTrial;
  readonly late_evidence: FrozenRecord<LateEvidenceAssessment> | undefined;
  readonly leak_audit: FrozenRecord<LeakAuditResult> | undefined;
  readonly contradictory_amendments: readonly StructuredReason[];
  readonly assessed_at: UtcMillis;
}

/** The comparison record and the run-level evidence integrity the summary also reports. */
export interface RunComparison {
  readonly assessment: ComparisonAssessment;
  readonly evidence_integrity: RunEvidenceIntegrity;
}

/**
 * Evaluates equality and eligibility for one run and builds its comparison assessment.
 *
 * @example
 * const { assessment } = assessRunComparison({ run_id, execution_manifest_sha256, trials,
 *   declared_variant_differences, trial_inputs, oracle_results, late_evidence, leak_audit,
 *   contradictory_amendments: [], assessed_at });
 * assessment.comparison_eligibility; // 'eligible' or 'ineligible' with its reasons
 */
export function assessRunComparison(input: RunComparisonInput): RunComparison {
  const equality = evaluateEquality(input.trial_inputs, input.declared_variant_differences);
  const evidenceIntegrity = deriveRunEvidenceIntegrity(input.trials, input.oracle_results);
  const eligibility = deriveComparisonEligibility({
    trials: input.trials,
    oracle_results: input.oracle_results,
    equality,
    evidence_integrity: evidenceIntegrity,
    late_evidence: input.late_evidence,
    contradictory_amendments: input.contradictory_amendments,
    leak_audit: input.leak_audit,
  });
  const oracleResultRefs = input.trials.flatMap((trial): readonly ArtifactRef[] => {
    const result = input.oracle_results.get(trial.trial_id);
    return result === undefined ? [] : [result.ref];
  });
  return {
    assessment: {
      schema_version: 1,
      record_type: 'comparison_assessment',
      run_id: input.run_id,
      execution_manifest_sha256: input.execution_manifest_sha256,
      oracle_result_refs: oracleResultRefs,
      equality_projections: equality.projections,
      equality_result: equality.equality_result,
      eligibility_checks: eligibility.checks,
      ...eligibilityOutcome(eligibility),
      assessed_at: input.assessed_at,
    },
    evidence_integrity: evidenceIntegrity,
  };
}

/**
 * The eligibility outcome alone, without its checks: the form the comparison record and the run
 * summary both carry.
 *
 * @example
 * eligibilityOutcome(eligibility); // { comparison_eligibility: 'eligible', comparison_ineligibility_reasons: [] }
 */
export function eligibilityOutcome(eligibility: ComparisonEligibilityOutcome): ComparisonEligibilityOutcome {
  return eligibility.comparison_eligibility === 'eligible'
    ? { comparison_eligibility: 'eligible', comparison_ineligibility_reasons: [] }
    : {
        comparison_eligibility: 'ineligible',
        comparison_ineligibility_reasons: eligibility.comparison_ineligibility_reasons,
      };
}
