// Every group-C example in one list, and one canonical example per record type. The mapped
// type makes the canonical table fail to compile when a record type lacks an example or an
// example has the wrong record type, so "every group-C type has a valid example" is total.

import type {
  GroupCRecordByType,
  GroupCRecordType,
} from '../../../../../src/record-contract/records/group-c/record-map.ts';
import type { GroupCExample } from '../support/record-example.ts';
import * as closure from './closure-examples.ts';
import * as operator from './operator-examples.ts';
import * as packages from './package-examples.ts';
import * as probe from './probe-examples.ts';
import * as summary from './summary-examples.ts';
import * as trialEvidence from './trial-evidence-examples.ts';

type CanonicalExamples = { readonly [K in GroupCRecordType]: () => GroupCRecordByType[K] };

export const CANONICAL_EXAMPLES: CanonicalExamples = {
  attempt_projection: trialEvidence.attemptProjection,
  oracle_result: trialEvidence.controlPassOracleResult,
  evidence_index: trialEvidence.trialEvidenceIndex,
  transport_probe_result: probe.passingTransportProbeResult,
  transport_probe_summary: probe.transportProbeSummary,
  validation_summary: summary.verifiedValidationSummary,
  run_summary: summary.eligibleRunSummary,
  comparison_assessment: summary.eligibleComparison,
  safety_assessment: closure.withinLimitsSafety,
  cleanup_result: closure.succeededCleanup,
  leak_audit_result: closure.cleanLeakAudit,
  late_evidence_record: closure.correlatedLateRecord,
  late_evidence_assessment: closure.quietLateEvidence,
  package_index: packages.runPackageIndex,
  package_verification: packages.eligiblePackage,
  probe_usability_assessment: probe.usableProbe,
  variant_validation_verification: summary.verifiedValidationVerification,
  study_completion_assessment: summary.completeStudy,
  amendment_index: packages.firstAmendmentIndex,
  operational_recovery_record: closure.operationalRecovery,
  billing_import: packages.withinLimitBilling,
  oracle_revision_check: operator.passedRevisionCheck,
  cli_result: operator.completedCliResult,
};

export const GROUP_C_EXAMPLES: readonly GroupCExample[] = [
  ...trialEvidence.TRIAL_EVIDENCE_EXAMPLES,
  ...probe.PROBE_EXAMPLES,
  ...summary.SUMMARY_EXAMPLES,
  ...closure.CLOSURE_EXAMPLES,
  ...packages.PACKAGE_EXAMPLES,
  ...operator.OPERATOR_EXAMPLES,
];
