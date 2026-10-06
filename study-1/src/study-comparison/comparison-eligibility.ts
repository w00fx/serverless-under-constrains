// Comparison eligibility (BR-RUA-031, BR-RUA-052; design §8.14): `eligible` iff all nine
// conditions hold. Each condition holds exactly when it has no reason, and the ineligibility reasons
// are the union of the conditions' reasons, each listed once. A `pass` or `fail` verdict is never
// read here: both are comparable outcomes. A cleanup failure or a leak that cannot process (D-30
// `storage_only`, `identity`) leaves the comparison eligible (AC-RUA-050); a `processing_capable` or
// `unknown` leak compromises isolation and settlement (BR-RUA-052) and makes it ineligible.

import type { StructuredReason } from '../record-contract/primitives.ts';
import type { DeclaredTrial } from '../record-contract/records/group-a/execution_manifest.ts';
import type { ComparisonCheck } from '../record-contract/records/group-c/comparison_assessment.ts';
import type { LateEvidenceAssessment } from '../record-contract/records/group-c/late_evidence_assessment.ts';
import type { LeakAuditResult } from '../record-contract/records/group-c/leak_audit_result.ts';
import type { OracleResult } from '../record-contract/records/group-c/oracle_result.ts';
import type { ComparisonEligibilityOutcome } from '../record-contract/records/group-c/run_summary.ts';
import type { ComparisonCheckId } from '../record-contract/records/group-c/vocabulary.ts';
import { leakCompromisesIsolation } from '../cleanup/leak-capability.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { comparisonReason, uniqueReasons } from './comparison-reasons.ts';
import type { EqualityAssessment } from './equality-evaluation.ts';
import type { FrozenRecord } from './record-files.ts';
import { missingOracleResultReason } from './run-evidence-integrity.ts';
import type { OracleResultsByTrial, RunEvidenceIntegrity } from './run-evidence-integrity.ts';

/** The nine conditions in `COMPARISON_CHECK_IDS` order. */
export type NineComparisonChecks = readonly [
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
  ComparisonCheck,
];

/** Everything the nine conditions read (design §5.3 `ComparisonEligibilityInput`). */
export interface ComparisonEligibilityInput {
  /** The manifest's four declared trials, in declared order. */
  readonly trials: readonly DeclaredTrial[];
  readonly oracle_results: OracleResultsByTrial;
  readonly equality: EqualityAssessment;
  readonly evidence_integrity: RunEvidenceIntegrity;
  readonly late_evidence: FrozenRecord<LateEvidenceAssessment> | undefined;
  /**
   * The reasons an effective amendment chain is contradictory (the package verifier's
   * `CONTRADICTORY_CHAIN`); empty when finalizing the original package, which has no amendment yet.
   */
  readonly contradictory_amendments: readonly StructuredReason[];
  readonly leak_audit: FrozenRecord<LeakAuditResult> | undefined;
}

/** The nine conditions and the outcome they give. */
export type ComparisonEligibility = ComparisonEligibilityOutcome & { readonly checks: NineComparisonChecks };

/**
 * Derives comparison eligibility from the nine BR-RUA-031 / BR-RUA-052 conditions.
 *
 * @example
 * const eligibility = deriveComparisonEligibility({ trials, oracle_results, equality, evidence_integrity,
 *   late_evidence, contradictory_amendments: [], leak_audit });
 * eligibility.comparison_eligibility; // 'eligible' when every condition holds
 */
export function deriveComparisonEligibility(input: ComparisonEligibilityInput): ComparisonEligibility {
  const checks: NineComparisonChecks = [
    check(
      'FOUR_ORACLE_RESULTS',
      input.trials.flatMap((trial) => missingResult(trial, input.oracle_results)),
    ),
    check(
      'ALL_TRIALS_VALID',
      perTrial(input, () => true, validityReason),
    ),
    check(
      'CONTROLS_VERIFIED',
      perTrial(input, (trial) => trial.scenario === 'CONTROL', controlReason),
    ),
    check(
      'TREATMENTS_VERIFIED',
      perTrial(input, (trial) => trial.scenario === 'COMMIT_THEN_TIMEOUT', treatmentReason),
    ),
    check('EQUALITY_PASSES', input.equality.reasons),
    check('EVIDENCE_INTEGRITY_VERIFIED', input.evidence_integrity.reasons),
    check('LATE_EVIDENCE_ACCEPTABLE', lateEvidenceReasons(input.late_evidence)),
    check('NO_CONTRADICTORY_AMENDMENT', input.contradictory_amendments.map(contradictoryReason)),
    check('NO_ISOLATION_COMPROMISING_LEAK', leakReasons(input.leak_audit)),
  ];
  const [first, ...rest] = uniqueReasons(checks.flatMap((entry) => entry.reasons));
  return first === undefined
    ? { comparison_eligibility: 'eligible', comparison_ineligibility_reasons: [], checks }
    : { comparison_eligibility: 'ineligible', comparison_ineligibility_reasons: [first, ...rest], checks };
}

function check(checkId: ComparisonCheckId, reasons: readonly StructuredReason[]): ComparisonCheck {
  return { check_id: checkId, holds: reasons.length === 0, reasons };
}

function missingResult(trial: DeclaredTrial, results: OracleResultsByTrial): readonly StructuredReason[] {
  return results.has(trial.trial_id) ? [] : [missingOracleResultReason(trial.trial_id)];
}

// The reasons of one per-trial condition over the trials it covers; a trial without a result cannot
// show the condition holds, so it repeats the missing-result reason.
function perTrial(
  input: ComparisonEligibilityInput,
  covers: (trial: DeclaredTrial) => boolean,
  reasonOf: (trial: DeclaredTrial, result: FrozenRecord<OracleResult>) => StructuredReason | undefined,
): readonly StructuredReason[] {
  return input.trials.filter(covers).flatMap((trial) => {
    const result = input.oracle_results.get(trial.trial_id);
    return result === undefined ? missingResult(trial, input.oracle_results) : (reasonOf(trial, result) ?? []);
  });
}

function validityReason(trial: DeclaredTrial, result: FrozenRecord<OracleResult>): StructuredReason | undefined {
  const validity = result.record.trial_validity;
  return validity === 'valid'
    ? undefined
    : comparisonReason(
        'TRIAL_NOT_VALID',
        trial.trial_id,
        `trial ${trial.trial_id} has trial_validity ${validity}; expected valid`,
        result.ref.artifact_path,
      );
}

function controlReason(trial: DeclaredTrial, result: FrozenRecord<OracleResult>): StructuredReason | undefined {
  const integrity = result.record.control_integrity;
  return integrity === 'verified'
    ? undefined
    : comparisonReason(
        'CONTROL_INTEGRITY_NOT_VERIFIED',
        trial.trial_id,
        `control trial ${trial.trial_id} has control_integrity ${integrity}; expected verified`,
        result.ref.artifact_path,
      );
}

function treatmentReason(trial: DeclaredTrial, result: FrozenRecord<OracleResult>): StructuredReason | undefined {
  const fidelity = result.record.treatment_fidelity;
  return fidelity === 'verified'
    ? undefined
    : comparisonReason(
        'TREATMENT_FIDELITY_NOT_VERIFIED',
        trial.trial_id,
        `treatment trial ${trial.trial_id} has treatment_fidelity ${fidelity}; expected verified`,
        result.ref.artifact_path,
      );
}

function lateEvidenceReasons(late: FrozenRecord<LateEvidenceAssessment> | undefined): readonly StructuredReason[] {
  const path = EXECUTION_PATHS.lateEvidenceAssessment;
  if (late === undefined) {
    return [
      comparisonReason(
        'ARTIFACT_MISSING',
        'late_evidence_status',
        `${path} is absent; expected the run's late-evidence assessment`,
        path,
      ),
    ];
  }
  const status = late.record.late_evidence_status;
  return status === 'none' || status === 'consistent'
    ? []
    : [
        comparisonReason(
          'LATE_EVIDENCE_NOT_ACCEPTABLE',
          'late_evidence_status',
          `late_evidence_status is ${status}; expected none or consistent`,
          path,
        ),
      ];
}

function contradictoryReason(reason: StructuredReason): StructuredReason {
  return comparisonReason('CONTRADICTORY_AMENDMENT', reason.subject, reason.detail, reason.artifact_path);
}

function leakReasons(audit: FrozenRecord<LeakAuditResult> | undefined): readonly StructuredReason[] {
  const path = EXECUTION_PATHS.leakAuditResult;
  if (audit === undefined) {
    return [
      comparisonReason(
        'ARTIFACT_MISSING',
        'leak_audit',
        `${path} is absent; expected the run's leak-audit result`,
        path,
      ),
    ];
  }
  return audit.record.leaks
    .filter(leakCompromisesIsolation)
    .map((leak) =>
      comparisonReason(
        'ISOLATION_COMPROMISING_LEAK',
        leak.identifier,
        `leaked ${leak.resource_type} ${leak.identifier} is ${leak.capability_class}; expected no processing_capable or unknown leak (D-30)`,
        path,
      ),
    );
}
