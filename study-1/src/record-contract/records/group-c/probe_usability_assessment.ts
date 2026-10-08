// Catalogue group C row 81 (design §6.2, §8.11): whether a probe may be selected as the
// qualification (BR-RUA-026, AC-RUA-056). Each unmet condition adds its reason code.

import type { EvidenceRef } from '../../evidence-refs.ts';
import type { Sha256Hex, StructuredReason, Uuid4, UtcMillis } from '../../primitives.ts';
import type { SafetyResult } from '../group-b/vocabulary.ts';
import type {
  ApplicableGateValue,
  EffectiveCleanupStatus,
  EffectiveLeakAuditStatus,
  Eligibility,
  LateEvidenceStatus,
  LeaseStatus,
  PreservationVerdict,
  ProbeUnusabilityCode,
  TrialValidity,
} from './vocabulary.ts';

/** A structured reason whose code is a probe-unusability code. */
export type ProbeUnusabilityReason = StructuredReason & { readonly code: ProbeUnusabilityCode };

/** `usable` iff every condition holds, so it has no reasons. */
export type ProbeUsabilityOutcome =
  | { readonly probe_usability: 'usable'; readonly reasons: readonly [] }
  | {
      readonly probe_usability: 'not_usable';
      readonly reasons: readonly [ProbeUnusabilityReason, ...ProbeUnusabilityReason[]];
    };

interface ProbeUsabilityFields {
  readonly schema_version: 1;
  readonly record_type: 'probe_usability_assessment';
  readonly transport_probe_id: Uuid4;
  readonly original_package_index_sha256: Sha256Hex;
  readonly selected_amendment_head_sha256: Sha256Hex | null;
  readonly transport_probe_verdict: PreservationVerdict;
  readonly probe_validity: TrialValidity;
  readonly treatment_fidelity: ApplicableGateValue;
  readonly evidence_integrity: ApplicableGateValue;
  /** Effective, after the selected amendment chain. */
  readonly late_evidence_status: LateEvidenceStatus;
  readonly effective_cleanup_status: EffectiveCleanupStatus;
  readonly effective_leak_audit_status: EffectiveLeakAuditStatus;
  readonly effective_lease_status: LeaseStatus;
  readonly safety_status: SafetyResult;
  readonly package_eligibility: Eligibility;
  /** Present when `admission/transport-scope-snapshot.json` exists and is indexed. */
  readonly transport_scope_snapshot_sha256?: Sha256Hex;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly assessed_at: UtcMillis;
}

/** Schema: `schemas/group-c/probe_usability_assessment.schema.json`. */
export type ProbeUsabilityAssessment = ProbeUsabilityFields & ProbeUsabilityOutcome;
