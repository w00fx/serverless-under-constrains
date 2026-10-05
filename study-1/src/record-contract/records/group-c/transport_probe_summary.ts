// Catalogue group C row 70 (design §6.2): the probe lifecycle summary written after cleanup
// (CTR-RUA-003). `COMPLETED` means the lifecycle completed, not that the transport passed.

import type { SafetyResult } from '../group-b/vocabulary.ts';
import type { Sha256Hex, Uuid4, UtcMillis } from '../../primitives.ts';
import type { ArtifactRef, ExecutionScoped } from './shared-shapes.ts';
import type {
  CleanupStatus,
  LateEvidenceStatus,
  LeakAuditStatus,
  LeaseStatus,
  ProbeTerminalReason,
} from './vocabulary.ts';

/** Schema: `schemas/group-c/transport_probe_summary.schema.json`. */
export interface TransportProbeSummary extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'transport_probe_summary';
  readonly transport_probe_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly probe_terminal_reason: ProbeTerminalReason;
  readonly cleanup_status: CleanupStatus;
  readonly leak_audit_status: LeakAuditStatus;
  readonly lease_status: LeaseStatus;
  readonly safety_status: SafetyResult;
  /** Digest of the exact bytes of `probe/derived/transport-probe-result.json`. */
  readonly probe_result_sha256: Sha256Hex;
  readonly late_evidence_status: LateEvidenceStatus;
  readonly late_evidence_assessment_ref: ArtifactRef;
  readonly created_at: UtcMillis;
}
