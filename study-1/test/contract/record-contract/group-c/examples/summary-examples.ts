// Group-C examples of the execution summaries and the verdicts over them: validation and run
// summaries, the comparison assessment, the variant-validation verification and the study
// completion assessment (catalogue rows 71-73, 82 and 83).

import type { Scenario, Uuid4, VariantId } from '../../../../../src/record-contract/primitives.ts';
import type {
  ComparisonAssessment,
  ComparisonCheck,
  EqualityProjection,
} from '../../../../../src/record-contract/records/group-c/comparison_assessment.ts';
import type { RunSummary } from '../../../../../src/record-contract/records/group-c/run_summary.ts';
import type {
  EvaluatedTrialResult,
  UnevaluatedTrialResult,
} from '../../../../../src/record-contract/records/group-c/shared-shapes.ts';
import type { StudyCompletionAssessment } from '../../../../../src/record-contract/records/group-c/study_completion_assessment.ts';
import type { ValidationSummary } from '../../../../../src/record-contract/records/group-c/validation_summary.ts';
import type { VariantValidationVerification } from '../../../../../src/record-contract/records/group-c/variant_validation_verification.ts';
import {
  COMPARISON_CHECK_IDS,
  EQUALITY_PROJECTION_IDS,
  STUDY_COMPLETION_CHECK_IDS,
} from '../../../../../src/record-contract/records/group-c/vocabulary.ts';
import type {
  ComparisonCheckId,
  EqualityProjectionId,
  PreservationVerdict,
  StudyCompletionCheckId,
} from '../../../../../src/record-contract/records/group-c/vocabulary.ts';
import {
  EXECUTION_MANIFEST_SHA256,
  RUN_ID,
  VALIDATION_ID,
  at,
  digest,
  reason,
  uuid,
} from '../../group-b/support/record-builders.ts';
import { EXECUTION_MANIFEST_PATH, artifactRef, evidenceRef } from '../support/group-c-builders.ts';
import { groupCExample } from '../support/record-example.ts';
import type { GroupCExample } from '../support/record-example.ts';

const RUN_TRIALS: readonly Uuid4[] = [uuid(0x601), uuid(0x602), uuid(0x603), uuid(0x604)];
const VALIDATION_TRIALS: readonly Uuid4[] = [uuid(0x611), uuid(0x612)];

function oracleResultPath(trialId: Uuid4 | undefined): string {
  return `trials/${String(trialId)}/derived/oracle-result.json`;
}

interface TrialSlot {
  readonly sequence: number;
  readonly trial_id: Uuid4;
  readonly variant_id: VariantId;
  readonly scenario: Scenario;
}

function slot(sequence: number, trialIds: readonly Uuid4[], variant: VariantId, scenario: Scenario): TrialSlot {
  const trialId = trialIds[sequence - 1];
  if (trialId === undefined) {
    throw new RangeError(`trial slot ${String(sequence)} is outside ${String(trialIds.length)} trials; expected 1..n`);
  }
  return { sequence, trial_id: trialId, variant_id: variant, scenario };
}

function evaluated(trial: TrialSlot, verdict: PreservationVerdict, correct: boolean | null): EvaluatedTrialResult {
  return {
    ...trial,
    execution_status: 'completed',
    oracle_result_ref: artifactRef(oracleResultPath(trial.trial_id)),
    preservation_verdict: verdict,
    correct_completion: correct,
    incompletion_reasons: [],
  };
}

function unevaluated(trial: TrialSlot, status: UnevaluatedTrialResult['execution_status']): UnevaluatedTrialResult {
  return { ...trial, execution_status: status, incompletion_reasons: [reason('TRIAL_NOT_FROZEN', 'trial')] };
}

const CLOSURE_REFS = {
  cleanup_result_ref: artifactRef('cleanup/cleanup-result.json'),
  late_evidence_assessment_ref: artifactRef('late-evidence/late-evidence-assessment.json'),
} as const;

/**
 * A verified durable validation: control pass, conclusive treatment, clean closure (BR-RUA-038).
 *
 * @example
 * verifiedValidationSummary().implementation_validation_status; // 'verified'
 */
export function verifiedValidationSummary(): ValidationSummary {
  return {
    schema_version: 1,
    record_type: 'validation_summary',
    variant_validation_id: VALIDATION_ID,
    variant_id: 'durable',
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    trial_results: [
      evaluated(slot(1, VALIDATION_TRIALS, 'durable', 'CONTROL'), 'pass', true),
      evaluated(slot(2, VALIDATION_TRIALS, 'durable', 'COMMIT_THEN_TIMEOUT'), 'pass', false),
    ],
    validation_terminal_reason: 'COMPLETED',
    validation_validity: 'valid',
    implementation_validation_status: 'verified',
    status_reasons: [],
    cleanup_status: 'succeeded',
    leak_audit_status: 'clean',
    lease_status: 'released',
    safety_status: 'within_limits',
    evidence_integrity_status: 'verified',
    late_evidence_status: 'none',
    ...CLOSURE_REFS,
    created_at: at(3000),
  };
}

/**
 * A failed validation: a trustworthy control fail and a conclusive treatment verdict (design
 * §8.15: an indeterminate treatment verdict would make it indeterminate), with its reason.
 *
 * @example
 * failedValidationSummary().implementation_validation_status; // 'failed'
 */
export function failedValidationSummary(): ValidationSummary {
  return {
    ...verifiedValidationSummary(),
    variant_id: 'conventional',
    trial_results: [
      evaluated(slot(1, VALIDATION_TRIALS, 'conventional', 'CONTROL'), 'fail', false),
      evaluated(slot(2, VALIDATION_TRIALS, 'conventional', 'COMMIT_THEN_TIMEOUT'), 'fail', false),
    ],
    implementation_validation_status: 'failed',
    status_reasons: [reason('CONTROL_FAILED', 'control trial')],
    safety_status: 'unverified',
    late_evidence_status: 'consistent',
  };
}

/**
 * An indeterminate validation whose treatment trial never started (D-29).
 *
 * @example
 * indeterminateValidationSummary().implementation_validation_status; // 'indeterminate'
 */
export function indeterminateValidationSummary(): ValidationSummary {
  return {
    ...verifiedValidationSummary(),
    trial_results: [
      evaluated(slot(1, VALIDATION_TRIALS, 'durable', 'CONTROL'), 'pass', true),
      unevaluated(slot(2, VALIDATION_TRIALS, 'durable', 'COMMIT_THEN_TIMEOUT'), 'not_started'),
    ],
    validation_terminal_reason: 'VALIDATION_INCOMPLETE',
    validation_validity: 'indeterminate',
    implementation_validation_status: 'indeterminate',
    status_reasons: [reason('TREATMENT_NOT_STARTED', 'treatment trial')],
    cleanup_status: 'partial',
    leak_audit_status: 'inconclusive',
    lease_status: 'recovery_required',
  };
}

/**
 * A completed run with four evaluated trials in declared order and an eligible comparison.
 *
 * @example
 * eligibleRunSummary().comparison_eligibility; // 'eligible'
 */
export function eligibleRunSummary(): RunSummary {
  return {
    schema_version: 1,
    record_type: 'run_summary',
    run_id: RUN_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    trial_results: [
      evaluated(slot(1, RUN_TRIALS, 'conventional', 'CONTROL'), 'pass', true),
      evaluated(slot(2, RUN_TRIALS, 'durable', 'CONTROL'), 'pass', true),
      evaluated(slot(3, RUN_TRIALS, 'conventional', 'COMMIT_THEN_TIMEOUT'), 'fail', false),
      evaluated(slot(4, RUN_TRIALS, 'durable', 'COMMIT_THEN_TIMEOUT'), 'pass', false),
    ],
    execution_status: 'completed',
    run_terminal_reason: 'COMPLETED',
    comparison_eligibility: 'eligible',
    comparison_ineligibility_reasons: [],
    cleanup_status: 'succeeded',
    leak_audit_status: 'clean',
    lease_status: 'released',
    safety_status: 'within_limits',
    evidence_integrity_status: 'verified',
    ...CLOSURE_REFS,
    comparison_assessment_ref: artifactRef('summary/comparison-assessment.json'),
    created_at: at(3100),
  };
}

/**
 * An incomplete run: the last trial could not be frozen, so the comparison is ineligible.
 *
 * @example
 * incompleteRunSummary().comparison_eligibility; // 'ineligible'
 */
export function incompleteRunSummary(): RunSummary {
  return {
    ...eligibleRunSummary(),
    trial_results: [
      evaluated(slot(1, RUN_TRIALS, 'conventional', 'CONTROL'), 'pass', true),
      evaluated(slot(2, RUN_TRIALS, 'durable', 'CONTROL'), 'indeterminate', null),
      evaluated(slot(3, RUN_TRIALS, 'conventional', 'COMMIT_THEN_TIMEOUT'), 'pass', false),
      unevaluated(slot(4, RUN_TRIALS, 'durable', 'COMMIT_THEN_TIMEOUT'), 'incomplete'),
    ],
    execution_status: 'incomplete',
    run_terminal_reason: 'TRIAL_INCOMPLETE',
    comparison_eligibility: 'ineligible',
    comparison_ineligibility_reasons: [reason('FOUR_ORACLE_RESULTS', 'comparison')],
    evidence_integrity_status: 'unverified',
  };
}

function projection(projectionId: EqualityProjectionId, result: PreservationVerdict): EqualityProjection {
  const values = [
    { trial_id: RUN_TRIALS[0] ?? uuid(0), value: { timeout_ms: 3000 } },
    { trial_id: RUN_TRIALS[1] ?? uuid(0), value: { timeout_ms: result === 'fail' ? 4000 : 3000 } },
  ];
  const differs = projectionId === 'caller_timing';
  return {
    projection_id: projectionId,
    result,
    compared_fields: ['/caller_timing/timeout_ms'],
    differences: differs ? [{ field: '/caller_timing/timeout_ms', declared: result !== 'fail', values }] : [],
    evidence_refs: [evidenceRef(EXECUTION_MANIFEST_PATH)],
  };
}

function projections(timing: PreservationVerdict): ComparisonAssessment['equality_projections'] {
  const resultOf = (id: EqualityProjectionId): PreservationVerdict => (id === 'caller_timing' ? timing : 'pass');
  const [p1, p2, p3, p4, p5, p6, p7, p8] = EQUALITY_PROJECTION_IDS;
  return [
    projection(p1, resultOf(p1)),
    projection(p2, resultOf(p2)),
    projection(p3, resultOf(p3)),
    projection(p4, resultOf(p4)),
    projection(p5, resultOf(p5)),
    projection(p6, resultOf(p6)),
    projection(p7, resultOf(p7)),
    projection(p8, resultOf(p8)),
  ];
}

function comparisonCheck(checkId: ComparisonCheckId, holds: boolean): ComparisonCheck {
  return {
    check_id: checkId,
    holds,
    reasons: holds ? [] : [reason('CHECK_DOES_NOT_HOLD', `comparison check ${checkId}`)],
  };
}

function comparisonChecks(failing?: ComparisonCheckId): ComparisonAssessment['eligibility_checks'] {
  const [c1, c2, c3, c4, c5, c6, c7, c8, c9] = COMPARISON_CHECK_IDS;
  const check = (id: ComparisonCheckId): ComparisonCheck => comparisonCheck(id, id !== failing);
  return [check(c1), check(c2), check(c3), check(c4), check(c5), check(c6), check(c7), check(c8), check(c9)];
}

/**
 * An eligible comparison whose one difference was declared (BR-RUA-031).
 *
 * @example
 * eligibleComparison().comparison_eligibility; // 'eligible'
 */
export function eligibleComparison(): ComparisonAssessment {
  return {
    schema_version: 1,
    record_type: 'comparison_assessment',
    run_id: RUN_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    oracle_result_refs: RUN_TRIALS.map((trialId) => artifactRef(oracleResultPath(trialId))),
    equality_projections: projections('pass'),
    equality_result: 'pass',
    eligibility_checks: comparisonChecks(),
    comparison_eligibility: 'eligible',
    comparison_ineligibility_reasons: [],
    assessed_at: at(3200),
  };
}

/**
 * An undeclared caller-timing difference fails equality, so the comparison is ineligible.
 *
 * @example
 * ineligibleComparison().comparison_eligibility; // 'ineligible'
 */
export function ineligibleComparison(): ComparisonAssessment {
  return {
    ...eligibleComparison(),
    equality_projections: projections('fail'),
    equality_result: 'fail',
    eligibility_checks: comparisonChecks('EQUALITY_PASSES'),
    comparison_eligibility: 'ineligible',
    comparison_ineligibility_reasons: [reason('EQUALITY_PASSES', 'caller_timing')],
  };
}

const VALIDATION_SUMMARY_PATH = 'summary/validation-summary.json';

/**
 * A verified validation package with no recovery amendment (CTR-RUA-004).
 *
 * @example
 * verifiedValidationVerification().effective_implementation_validation_status; // 'verified'
 */
export function verifiedValidationVerification(): VariantValidationVerification {
  return {
    schema_version: 1,
    record_type: 'variant_validation_verification',
    variant_validation_id: VALIDATION_ID,
    validation_summary_ref: {
      ...artifactRef(VALIDATION_SUMMARY_PATH),
      package_index_sha256: digest('validation-package-index'),
    },
    original_package_index_sha256: digest('validation-package-index'),
    selected_amendment_head_sha256: digest('validation-amendment-1'),
    package_eligibility: 'eligible',
    declared_implementation_validation_status: 'indeterminate',
    effective_implementation_validation_status: 'verified',
    effective_cleanup_status: 'succeeded',
    effective_leak_audit_status: 'clean',
    effective_lease_status: 'released',
    operational_recovery_applied: true,
    effective_status_reasons: [],
    evidence_refs: [evidenceRef(VALIDATION_SUMMARY_PATH, { package_index_sha256: digest('validation-package-index') })],
    checked_at: at(3300),
    validation_validity: 'valid',
  };
}

/**
 * An ineligible validation package leaves the effective status indeterminate.
 *
 * @example
 * indeterminateValidationVerification().effective_implementation_validation_status; // 'indeterminate'
 */
export function indeterminateValidationVerification(): VariantValidationVerification {
  return {
    ...verifiedValidationVerification(),
    selected_amendment_head_sha256: null,
    package_eligibility: 'ineligible',
    effective_implementation_validation_status: 'indeterminate',
    effective_cleanup_status: 'unverified',
    effective_leak_audit_status: 'unverified',
    effective_lease_status: 'unverified',
    operational_recovery_applied: false,
    effective_status_reasons: [reason('PACKAGE_NOT_VERIFIED', 'validation package')],
    validation_validity: 'indeterminate',
  };
}

function completionChecks(failing?: StudyCompletionCheckId): StudyCompletionAssessment['checks'] {
  const [k1, k2, k3, k4, k5, k6, k7] = STUDY_COMPLETION_CHECK_IDS;
  const check = (id: StudyCompletionCheckId): { check_id: StudyCompletionCheckId; holds: boolean } => ({
    check_id: id,
    holds: id !== failing,
  });
  return [check(k1), check(k2), check(k3), check(k4), check(k5), check(k6), check(k7)];
}

/**
 * A complete study over the original run package (BR-RUA-054).
 *
 * @example
 * completeStudy().study_completion; // 'complete'
 */
export function completeStudy(): StudyCompletionAssessment {
  return {
    schema_version: 1,
    record_type: 'study_completion_assessment',
    run_id: RUN_ID,
    original_package_index_sha256: digest('run-package-index'),
    study_completion: 'complete',
    comparison_eligibility: 'eligible',
    package_eligibility: 'eligible',
    cleanup_status: 'succeeded',
    leak_audit_status: 'clean',
    lease_status: 'released',
    run_terminal_reason: 'COMPLETED',
    checks: completionChecks(),
    incompletion_reasons: [],
    evidence_refs: [evidenceRef('summary/run-summary.json', { package_index_sha256: digest('run-package-index') })],
    assessed_at: at(3400),
  };
}

/**
 * A run whose lease needs recovery leaves the study incomplete (AC-RUA-038).
 *
 * @example
 * incompleteStudy().study_completion; // 'incomplete'
 */
export function incompleteStudy(): StudyCompletionAssessment {
  return {
    ...completeStudy(),
    study_completion: 'incomplete',
    lease_status: 'recovery_required',
    checks: completionChecks('NO_REMAINING_OWNED_RESOURCE'),
    incompletion_reasons: [reason('LEASE_RECOVERY_REQUIRED', 'coordination lease')],
  };
}

export const SUMMARY_EXAMPLES: readonly GroupCExample[] = [
  groupCExample('validation_summary', verifiedValidationSummary()),
  groupCExample('validation_summary (failed)', failedValidationSummary()),
  groupCExample('validation_summary (indeterminate)', indeterminateValidationSummary()),
  groupCExample('run_summary', eligibleRunSummary()),
  groupCExample('run_summary (incomplete)', incompleteRunSummary()),
  groupCExample('comparison_assessment', eligibleComparison()),
  groupCExample('comparison_assessment (ineligible)', ineligibleComparison()),
  groupCExample('variant_validation_verification', verifiedValidationVerification()),
  groupCExample('variant_validation_verification (indeterminate)', indeterminateValidationVerification()),
  groupCExample('study_completion_assessment', completeStudy()),
  groupCExample('study_completion_assessment (incomplete)', incompleteStudy()),
];
