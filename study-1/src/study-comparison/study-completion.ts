// Canonical study completion (BR-RUA-054; design §8.14; AC-RUA-027, AC-RUA-038). A verifier derives
// it and never freezes it into the package. It reads the ORIGINAL package only: the six status
// values come from the original run summary, and an operational-recovery amendment that later
// repairs cleanup, the audit or the lease changes none of them, so a recovered run can never
// complete the study. The only thing taken from outside the original package is what the package
// verifier and the billing import establish about it: package eligibility, a contradictory
// amendment chain, and a breached billed cost (a known safety breach).

import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../record-contract/primitives.ts';
import type { ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { SourceProvenance } from '../record-contract/records/group-a/source_provenance.ts';
import type { ComparisonAssessment } from '../record-contract/records/group-c/comparison_assessment.ts';
import type { LeakAuditResult } from '../record-contract/records/group-c/leak_audit_result.ts';
import type { PackageVerification } from '../record-contract/records/group-c/package_verification.ts';
import type { RunSummary } from '../record-contract/records/group-c/run_summary.ts';
import type {
  StudyCompletionAssessment,
  StudyCompletionCheck,
} from '../record-contract/records/group-c/study_completion_assessment.ts';
import type { BilledCostCheck, StudyCompletionCheckId } from '../record-contract/records/group-c/vocabulary.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { comparisonReason, uniqueReasons, uniqueSortedRefs } from './comparison-reasons.ts';
import type { FrozenRecord } from './record-files.ts';
import { missingOracleResultReason } from './run-evidence-integrity.ts';
import { qualificationReasons, sourceReasons } from './study-provenance.ts';
import type { SelectedRunQualification } from './study-provenance.ts';

/** What the completion verifier reads (design §5.3 `StudyCompletionInput`). */
export interface StudyCompletionInput {
  readonly run_id: Uuid4;
  /** The digest of the original package's `package-index.json`. */
  readonly original_package_index_sha256: Sha256Hex;
  readonly package_verification: PackageVerification;
  readonly execution_manifest: FrozenRecord<ExecutionManifest> | undefined;
  readonly run_summary: FrozenRecord<RunSummary> | undefined;
  readonly comparison_assessment: FrozenRecord<ComparisonAssessment> | undefined;
  readonly leak_audit: FrozenRecord<LeakAuditResult> | undefined;
  readonly source_provenance: FrozenRecord<SourceProvenance> | undefined;
  /** BR-RUA-047 billed-cost checks known for the run; a `breached` one is a known safety breach. */
  readonly billed_cost_checks: readonly BilledCostCheck[];
  readonly selected_qualification: SelectedRunQualification | undefined;
  readonly assessed_at: UtcMillis;
}

type SevenChecks = StudyCompletionAssessment['checks'];

/**
 * Assesses BR-RUA-054 over the original package.
 *
 * @example
 * const completion = assessStudyCompletion({ run_id, original_package_index_sha256, package_verification,
 *   execution_manifest, run_summary, comparison_assessment, leak_audit, source_provenance,
 *   billed_cost_checks: [], selected_qualification, assessed_at });
 * completion.study_completion; // 'complete' only for a clean original closure
 */
export function assessStudyCompletion(input: StudyCompletionInput): StudyCompletionAssessment {
  const oracleResults = oracleResultReasons(input.run_summary);
  const equality = equalityReasons(input.comparison_assessment);
  const integrity = integrityReasons(input.run_summary);
  const contradictory = contradictoryReasons(input.package_verification);
  const safety = safetyReasons(input.run_summary, input.billed_cost_checks);
  const remaining = remainingResourceReasons(input.leak_audit);
  const provenance = [
    ...sourceReasons(input.execution_manifest, input.source_provenance),
    ...qualificationReasons(input.execution_manifest, input.selected_qualification),
  ];
  const checks: SevenChecks = [
    completionCheck('FOUR_ORACLE_RESULTS', oracleResults),
    completionCheck('EQUALITY_EVALUATED', equality),
    completionCheck('EVIDENCE_INTEGRITY_VERIFIED', integrity),
    completionCheck('NO_CONTRADICTORY_AMENDMENT', contradictory),
    completionCheck('NO_KNOWN_SAFETY_BREACH', safety),
    completionCheck('NO_REMAINING_OWNED_RESOURCE', remaining),
    completionCheck('CLEAN_SOURCE_AND_MATCHING_QUALIFICATION', provenance),
  ];
  const status = originalStatus(input);
  const [first, ...rest] = uniqueReasons([
    ...status.reasons,
    ...oracleResults,
    ...equality,
    ...integrity,
    ...contradictory,
    ...safety,
    ...remaining,
    ...provenance,
  ]);
  const head = {
    schema_version: 1,
    record_type: 'study_completion_assessment',
    run_id: input.run_id,
    original_package_index_sha256: input.original_package_index_sha256,
    checks,
    evidence_refs: crossPackageRefs(input),
    assessed_at: input.assessed_at,
  } as const;
  if (first === undefined) {
    // No reason means every status value was exactly the BR-RUA-054 value and every check held.
    return {
      ...head,
      study_completion: 'complete',
      comparison_eligibility: 'eligible',
      package_eligibility: 'eligible',
      cleanup_status: 'succeeded',
      leak_audit_status: 'clean',
      lease_status: 'released',
      run_terminal_reason: 'COMPLETED',
      incompletion_reasons: [],
    };
  }
  return { ...head, study_completion: 'incomplete', ...status.values, incompletion_reasons: [first, ...rest] };
}

function completionCheck(checkId: StudyCompletionCheckId, reasons: readonly StructuredReason[]): StudyCompletionCheck {
  return { check_id: checkId, holds: reasons.length === 0 };
}

type StatusValues = Pick<
  StudyCompletionAssessment,
  | 'comparison_eligibility'
  | 'package_eligibility'
  | 'cleanup_status'
  | 'leak_audit_status'
  | 'lease_status'
  | 'run_terminal_reason'
>;

// The six BR-RUA-054 values as the original package states them. Without a summary the run never
// finalized, so nothing is established: the closure values are the "not established" ones and the
// terminal reason is the finalization failure.
function originalStatus(input: StudyCompletionInput): {
  readonly values: StatusValues;
  readonly reasons: readonly StructuredReason[];
} {
  const summary = input.run_summary?.record;
  const verification = input.package_verification;
  const packageEligible =
    verification.package_eligibility === 'eligible' &&
    verification.original_package_index_sha256 === input.original_package_index_sha256;
  const values: StatusValues = {
    comparison_eligibility: summary?.comparison_eligibility ?? 'ineligible',
    package_eligibility: packageEligible ? 'eligible' : 'ineligible',
    cleanup_status: summary?.cleanup_status ?? 'not_started',
    leak_audit_status: summary?.leak_audit_status ?? 'inconclusive',
    lease_status: summary?.lease_status ?? 'unverified',
    run_terminal_reason: summary?.run_terminal_reason ?? 'EVIDENCE_FINALIZATION_FAILED',
  };
  return {
    values,
    reasons: [
      ...(summary === undefined ? [summaryMissing()] : []),
      ...(packageEligible ? [] : [packageReason(input)]),
      ...valueReasons(values),
    ],
  };
}

function valueReasons(values: StatusValues): readonly StructuredReason[] {
  const path = EXECUTION_PATHS.runSummary;
  const expected: readonly (readonly [
    'comparison_eligibility' | 'cleanup_status' | 'leak_audit_status' | 'lease_status' | 'run_terminal_reason',
    string,
    'COMPARISON_NOT_ELIGIBLE' | 'CLOSURE_NOT_CLEAN' | 'RUN_NOT_COMPLETED',
  ])[] = [
    ['comparison_eligibility', 'eligible', 'COMPARISON_NOT_ELIGIBLE'],
    ['cleanup_status', 'succeeded', 'CLOSURE_NOT_CLEAN'],
    ['leak_audit_status', 'clean', 'CLOSURE_NOT_CLEAN'],
    ['lease_status', 'released', 'CLOSURE_NOT_CLEAN'],
    ['run_terminal_reason', 'COMPLETED', 'RUN_NOT_COMPLETED'],
  ];
  return expected
    .filter(([field, want]) => values[field] !== want)
    .map(([field, want, code]) =>
      comparisonReason(code, field, `the original ${path} has ${field} ${values[field]}; expected ${want}`, path),
    );
}

function summaryMissing(): StructuredReason {
  const path = EXECUTION_PATHS.runSummary;
  return comparisonReason(
    'ARTIFACT_MISSING',
    'run_summary',
    `${path} is absent or unreadable; expected the original run summary`,
    path,
  );
}

function packageReason(input: StudyCompletionInput): StructuredReason {
  const verification = input.package_verification;
  const codes = verification.package_ineligibility_reasons.map((reason) => reason.code);
  const scope =
    verification.original_package_index_sha256 === input.original_package_index_sha256
      ? `ineligible with ${codes.join(', ')}`
      : `of package index ${verification.original_package_index_sha256}, not ${input.original_package_index_sha256}`;
  return comparisonReason(
    'PACKAGE_NOT_ELIGIBLE',
    'package_eligibility',
    `the package verification is ${scope}; expected an eligible verification of the original package`,
    EXECUTION_PATHS.packageIndex,
  );
}

function oracleResultReasons(summary: FrozenRecord<RunSummary> | undefined): readonly StructuredReason[] {
  if (summary === undefined) {
    return [summaryMissing()];
  }
  return summary.record.trial_results
    .filter((entry) => !('oracle_result_ref' in entry))
    .map((entry) => missingOracleResultReason(entry.trial_id));
}

function equalityReasons(comparison: FrozenRecord<ComparisonAssessment> | undefined): readonly StructuredReason[] {
  const path = EXECUTION_PATHS.comparisonAssessment;
  if (comparison === undefined) {
    return [
      comparisonReason(
        'ARTIFACT_MISSING',
        'equality_result',
        `${path} is absent or unreadable; expected the original comparison assessment`,
        path,
      ),
    ];
  }
  return comparison.record.equality_result === 'indeterminate'
    ? [
        comparisonReason(
          'EQUALITY_NOT_EVALUATED',
          'equality_result',
          'BR-RUA-007 equality is indeterminate; expected a completed evaluation (pass or fail)',
          path,
        ),
      ]
    : [];
}

function integrityReasons(summary: FrozenRecord<RunSummary> | undefined): readonly StructuredReason[] {
  if (summary === undefined) {
    return [summaryMissing()];
  }
  const status = summary.record.evidence_integrity_status;
  return status === 'verified'
    ? []
    : [
        comparisonReason(
          'EVIDENCE_INTEGRITY_NOT_VERIFIED',
          'evidence_integrity_status',
          `evidence_integrity_status is ${status}; expected verified`,
          summary.ref.artifact_path,
        ),
      ];
}

function contradictoryReasons(verification: PackageVerification): readonly StructuredReason[] {
  return verification.package_ineligibility_reasons
    .filter((reason) => reason.code === 'CONTRADICTORY_CHAIN')
    .map((reason) => comparisonReason('CONTRADICTORY_AMENDMENT', reason.subject, reason.detail, reason.artifact_path));
}

function safetyReasons(
  summary: FrozenRecord<RunSummary> | undefined,
  billed: readonly BilledCostCheck[],
): readonly StructuredReason[] {
  const breaches = [
    ...(summary?.record.safety_status === 'breached'
      ? [
          comparisonReason(
            'KNOWN_SAFETY_BREACH',
            'safety_status',
            'the original run summary has safety_status breached; expected no known breach',
            summary.ref.artifact_path,
          ),
        ]
      : []),
    ...(billed.includes('breached')
      ? [
          comparisonReason(
            'KNOWN_SAFETY_BREACH',
            'billed_cost_check',
            'a billed-cost check is breached; expected no known breach (BR-RUA-047)',
          ),
        ]
      : []),
  ];
  return summary === undefined ? [summaryMissing(), ...breaches] : breaches;
}

function remainingResourceReasons(audit: FrozenRecord<LeakAuditResult> | undefined): readonly StructuredReason[] {
  const path = EXECUTION_PATHS.leakAuditResult;
  if (audit === undefined) {
    return [
      comparisonReason(
        'ARTIFACT_MISSING',
        'leak_audit',
        `${path} is absent or unreadable; expected the original leak-audit result`,
        path,
      ),
    ];
  }
  return audit.record.leaks.map((leak) =>
    comparisonReason(
      'OWNED_RESOURCE_REMAINS',
      leak.identifier,
      `owned ${leak.resource_type} ${leak.identifier} was still observed after cleanup; expected none`,
      path,
    ),
  );
}

// Every record the verdict read, as a reference into the original package: the assessment lives
// outside every package, so each reference pins the original package index (BR-RUA-035).
function crossPackageRefs(input: StudyCompletionInput): readonly EvidenceRef[] {
  const read = [
    input.execution_manifest,
    input.run_summary,
    input.comparison_assessment,
    input.leak_audit,
    input.source_provenance,
  ];
  return uniqueSortedRefs(
    read.flatMap((frozen) =>
      frozen === undefined ? [] : [{ ...frozen.ref, package_index_sha256: input.original_package_index_sha256 }],
    ),
  );
}
