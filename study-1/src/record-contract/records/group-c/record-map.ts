// The record type of every group-C name, so generic code can map a `record_type` to its
// interface without a barrel that spans the three catalogue groups (design §13 contention
// rule 2). Type-only: it has no runtime part.

import type { AttemptProjection } from './attempt_projection.ts';
import type { OracleResult } from './oracle_result.ts';
import type { EvidenceIndex } from './evidence_index.ts';
import type { TransportProbeResult } from './transport_probe_result.ts';
import type { TransportProbeSummary } from './transport_probe_summary.ts';
import type { ValidationSummary } from './validation_summary.ts';
import type { RunSummary } from './run_summary.ts';
import type { ComparisonAssessment } from './comparison_assessment.ts';
import type { SafetyAssessment } from './safety_assessment.ts';
import type { CleanupResult } from './cleanup_result.ts';
import type { LeakAuditResult } from './leak_audit_result.ts';
import type { LateEvidenceRecord } from './late_evidence_record.ts';
import type { LateEvidenceAssessment } from './late_evidence_assessment.ts';
import type { PackageIndex } from './package_index.ts';
import type { PackageVerification } from './package_verification.ts';
import type { ProbeUsabilityAssessment } from './probe_usability_assessment.ts';
import type { VariantValidationVerification } from './variant_validation_verification.ts';
import type { StudyCompletionAssessment } from './study_completion_assessment.ts';
import type { AmendmentIndex } from './amendment_index.ts';
import type { OperationalRecoveryRecord } from './operational_recovery_record.ts';
import type { BillingImport } from './billing_import.ts';
import type { OracleRevisionCheck } from './oracle_revision_check.ts';
import type { CliResult } from './cli_result.ts';

/**
 * Maps each group-C `record_type` to its TypeScript record type.
 *
 * @example
 * type Result = GroupCRecordByType['oracle_result']; // OracleResult
 */
export interface GroupCRecordByType {
  readonly attempt_projection: AttemptProjection;
  readonly oracle_result: OracleResult;
  readonly evidence_index: EvidenceIndex;
  readonly transport_probe_result: TransportProbeResult;
  readonly transport_probe_summary: TransportProbeSummary;
  readonly validation_summary: ValidationSummary;
  readonly run_summary: RunSummary;
  readonly comparison_assessment: ComparisonAssessment;
  readonly safety_assessment: SafetyAssessment;
  readonly cleanup_result: CleanupResult;
  readonly leak_audit_result: LeakAuditResult;
  readonly late_evidence_record: LateEvidenceRecord;
  readonly late_evidence_assessment: LateEvidenceAssessment;
  readonly package_index: PackageIndex;
  readonly package_verification: PackageVerification;
  readonly probe_usability_assessment: ProbeUsabilityAssessment;
  readonly variant_validation_verification: VariantValidationVerification;
  readonly study_completion_assessment: StudyCompletionAssessment;
  readonly amendment_index: AmendmentIndex;
  readonly operational_recovery_record: OperationalRecoveryRecord;
  readonly billing_import: BillingImport;
  readonly oracle_revision_check: OracleRevisionCheck;
  readonly cli_result: CliResult;
}

/** A group-C record type name. */
export type GroupCRecordType = keyof GroupCRecordByType;

/** Any group-C record. */
export type GroupCRecord = GroupCRecordByType[GroupCRecordType];
