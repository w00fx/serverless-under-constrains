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
  PostFreezeProbeTerminalReason,
  ProbeTerminalReason,
} from './vocabulary.ts';

interface TransportProbeSummaryFields extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'transport_probe_summary';
  readonly transport_probe_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly cleanup_status: CleanupStatus;
  readonly leak_audit_status: LeakAuditStatus;
  readonly lease_status: LeaseStatus;
  readonly safety_status: SafetyResult;
  readonly late_evidence_status: LateEvidenceStatus;
  readonly late_evidence_assessment_ref: ArtifactRef;
  readonly created_at: UtcMillis;
}

/**
 * The probe-result digest (the exact bytes of `probe/derived/transport-probe-result.json`) is
 * present when the lifecycle `COMPLETED`, and when it ended in `CLEANUP_INCOMPLETE` or
 * `LEAK_AUDIT_NOT_CLEAN`: those arise only in normal cleanup, after phase P5 froze the result
 * (design §10.2). A probe whose primary reason can come before P5 (for example
 * `LEASE_ACQUISITION_FAILED`, `PROVISIONING_FAILED`, `PROBE_INCOMPLETE` or an interruption) omits
 * it when no result was frozen, because BR-RUA-033 omits unavailable optional properties.
 */
export type ProbeResultDigest =
  | {
      readonly probe_terminal_reason: PostFreezeProbeTerminalReason;
      readonly probe_result_sha256: Sha256Hex;
    }
  | {
      readonly probe_terminal_reason: Exclude<ProbeTerminalReason, PostFreezeProbeTerminalReason>;
      readonly probe_result_sha256?: Sha256Hex;
    };

/** Schema: `schemas/group-c/transport_probe_summary.schema.json`. */
export type TransportProbeSummary = TransportProbeSummaryFields & ProbeResultDigest;
