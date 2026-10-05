// Catalogue group C row 85 (design §6.2, §10.4): the payload of an `OPERATIONAL_RECOVERY`
// amendment. Recovery may repair only cleanup, leak-audit and lease closure (BR-RUA-038,
// CTR-RUA-004), so those three values are the only closure it records.

import type { Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../../primitives.ts';
import type { ArtifactRef, ExecutionCorrelation } from './shared-shapes.ts';
import type { LeakAuditStatus, LeaseStatus, TerminalCleanupStatus } from './vocabulary.ts';

/** The three repairable closure values. */
export interface OperationalClosure {
  readonly cleanup_status: TerminalCleanupStatus;
  readonly leak_audit_status: LeakAuditStatus;
  readonly lease_status: LeaseStatus;
}

interface OperationalRecoveryFields {
  readonly schema_version: 1;
  readonly record_type: 'operational_recovery_record';
  readonly recovery_id: Uuid4;
  readonly original_package_index_sha256: Sha256Hex;
  readonly original_closure: OperationalClosure;
  readonly recovered_closure: OperationalClosure;
  /** Cleanup steps rerun, from BR-RUA-048 steps 3-11, ascending. */
  readonly steps_run: readonly number[];
  /** Results written inside the amendment payload. */
  readonly cleanup_result_ref: ArtifactRef;
  readonly leak_audit_result_ref: ArtifactRef;
  readonly reasons: readonly StructuredReason[];
  readonly started_at: UtcMillis;
  readonly completed_at: UtcMillis;
}

/** Schema: `schemas/group-c/operational_recovery_record.schema.json`. */
export type OperationalRecoveryRecord = ExecutionCorrelation & OperationalRecoveryFields;
