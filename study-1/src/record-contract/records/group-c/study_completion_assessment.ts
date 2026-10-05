// Catalogue group C row 83 (design §6.2, §8.14): the BR-RUA-054 study-completion verdict over
// the ORIGINAL run package. Operational-recovery amendments never complete a study (AC-RUA-038).

import type { EvidenceRef } from '../../evidence-refs.ts';
import type { Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../../primitives.ts';
import type {
  CleanupStatus,
  Eligibility,
  LeakAuditStatus,
  LeaseStatus,
  RunTerminalReason,
  StudyCompletionCheckId,
} from './vocabulary.ts';

/** One BR-RUA-054 condition beyond the six status values, and whether it holds. */
export interface StudyCompletionCheck {
  readonly check_id: StudyCompletionCheckId;
  readonly holds: boolean;
}

type SevenChecks = readonly [
  StudyCompletionCheck,
  StudyCompletionCheck,
  StudyCompletionCheck,
  StudyCompletionCheck,
  StudyCompletionCheck,
  StudyCompletionCheck,
  StudyCompletionCheck,
];

/** The six values BR-RUA-054 names, as found in the original package. */
interface OriginalStatusValues {
  readonly comparison_eligibility: Eligibility;
  readonly package_eligibility: Eligibility;
  readonly cleanup_status: CleanupStatus;
  readonly leak_audit_status: LeakAuditStatus;
  readonly lease_status: LeaseStatus;
  readonly run_terminal_reason: RunTerminalReason;
}

/** `complete` only with the exact BR-RUA-054 values, every check holding and no reason. */
export type StudyCompletionOutcome =
  | {
      readonly study_completion: 'complete';
      readonly comparison_eligibility: 'eligible';
      readonly package_eligibility: 'eligible';
      readonly cleanup_status: 'succeeded';
      readonly leak_audit_status: 'clean';
      readonly lease_status: 'released';
      readonly run_terminal_reason: 'COMPLETED';
      readonly incompletion_reasons: readonly [];
    }
  | (OriginalStatusValues & {
      readonly study_completion: 'incomplete';
      readonly incompletion_reasons: readonly [StructuredReason, ...StructuredReason[]];
    });

interface StudyCompletionFields {
  readonly schema_version: 1;
  readonly record_type: 'study_completion_assessment';
  readonly run_id: Uuid4;
  readonly original_package_index_sha256: Sha256Hex;
  readonly checks: SevenChecks;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly assessed_at: UtcMillis;
}

/** Schema: `schemas/group-c/study_completion_assessment.schema.json`. */
export type StudyCompletionAssessment = StudyCompletionFields & StudyCompletionOutcome;
