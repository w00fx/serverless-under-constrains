// Probe usability (BR-RUA-026, AC-RUA-056, design §8.11). A probe may be selected by later
// executions only when every row holds; each unmet row adds its reason, in this order:
//
//   transport_probe_verdict = pass                               PROBE_NOT_PASSING
//   probe_validity = valid and treatment_fidelity = verified     PROBE_INVALID_OR_UNFAITHFUL
//   evidence_integrity = verified                                EVIDENCE_NOT_VERIFIED
//   effective late evidence none or consistent                   LATE_EVIDENCE_CONTRADICTORY / _UNVERIFIED
//   effective closure: cleanup succeeded, audit clean, released  OPERATIONAL_CLOSURE_NOT_CLEAN
//   no known safety breach                                       KNOWN_SAFETY_BREACH
//   package eligible for the selected original index and head    PACKAGE_NOT_VERIFIED
//   the transport-scope snapshot exists and is indexed           NO_TRANSPORT_SCOPE_SNAPSHOT
//
// A safety status of `unverified` is not a known breach (BR-RUA-026 "no safety breach is known").

import type { EvidenceRef } from '../../record-contract/evidence-refs.ts';
import type { Sha256Hex, Uuid4, UtcMillis } from '../../record-contract/primitives.ts';
import type { SafetyResult } from '../../record-contract/records/group-b/vocabulary.ts';
import type {
  ProbeUnusabilityReason,
  ProbeUsabilityAssessment,
  ProbeUsabilityOutcome,
} from '../../record-contract/records/group-c/probe_usability_assessment.ts';
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
} from '../../record-contract/records/group-c/vocabulary.ts';
import { canonicalRefs } from '../../treatment-fidelity/condition-result.ts';

const SUBJECT = 'BR-RUA-026';

/** What the frozen probe result says, or the unknown values when it cannot be read. */
export interface ProbeOutcomeFacts {
  readonly transport_probe_verdict: PreservationVerdict;
  readonly probe_validity: TrialValidity;
  readonly treatment_fidelity: ApplicableGateValue;
  readonly evidence_integrity: ApplicableGateValue;
}

/** The effective operational closure after the selected amendment chain (CTR-RUA-004). */
export interface EffectiveClosure {
  readonly effective_cleanup_status: EffectiveCleanupStatus;
  readonly effective_leak_audit_status: EffectiveLeakAuditStatus;
  readonly effective_lease_status: LeaseStatus;
}

/** Every fact BR-RUA-026 judges, as read from the probe's package and its selected chain. */
export interface ProbeUsabilityInput {
  readonly transport_probe_id: Uuid4;
  readonly original_package_index_sha256: Sha256Hex;
  readonly selected_amendment_head_sha256: Sha256Hex | null;
  readonly probe: ProbeOutcomeFacts;
  readonly late_evidence_status: LateEvidenceStatus;
  readonly closure: EffectiveClosure;
  readonly safety_status: SafetyResult;
  readonly package_eligibility: Eligibility;
  /** Present only when `admission/transport-scope-snapshot.json` exists, is indexed and is readable. */
  readonly transport_scope_snapshot_sha256?: Sha256Hex;
  /** Cross-package references: each names the original package-index digest (BR-RUA-035). */
  readonly evidence_refs: readonly EvidenceRef[];
  readonly assessed_at: UtcMillis;
}

/**
 * Assesses whether a probe may be selected.
 *
 * @example
 * assessProbeUsability(input).probe_usability; // 'usable' only when every BR-RUA-026 row holds
 */
export function assessProbeUsability(input: ProbeUsabilityInput): ProbeUsabilityAssessment {
  return {
    schema_version: 1,
    record_type: 'probe_usability_assessment',
    transport_probe_id: input.transport_probe_id,
    original_package_index_sha256: input.original_package_index_sha256,
    selected_amendment_head_sha256: input.selected_amendment_head_sha256,
    ...outcomeOf(unmetRows(input)),
    transport_probe_verdict: input.probe.transport_probe_verdict,
    probe_validity: input.probe.probe_validity,
    treatment_fidelity: input.probe.treatment_fidelity,
    evidence_integrity: input.probe.evidence_integrity,
    late_evidence_status: input.late_evidence_status,
    ...input.closure,
    safety_status: input.safety_status,
    package_eligibility: input.package_eligibility,
    ...(input.transport_scope_snapshot_sha256 === undefined
      ? {}
      : { transport_scope_snapshot_sha256: input.transport_scope_snapshot_sha256 }),
    evidence_refs: canonicalRefs(input.evidence_refs),
    assessed_at: input.assessed_at,
  };
}

function unmetRows(input: ProbeUsabilityInput): readonly ProbeUnusabilityReason[] {
  const { probe, closure } = input;
  return [
    unmet(
      probe.transport_probe_verdict === 'pass',
      'PROBE_NOT_PASSING',
      `transport_probe_verdict is ${probe.transport_probe_verdict}; expected pass`,
    ),
    unmet(
      probe.probe_validity === 'valid' && probe.treatment_fidelity === 'verified',
      'PROBE_INVALID_OR_UNFAITHFUL',
      `probe_validity is ${probe.probe_validity} and treatment_fidelity is ${probe.treatment_fidelity}; expected valid and verified`,
    ),
    unmet(
      probe.evidence_integrity === 'verified',
      'EVIDENCE_NOT_VERIFIED',
      `evidence_integrity is ${probe.evidence_integrity}; expected verified`,
    ),
    lateEvidenceRow(input.late_evidence_status),
    unmet(
      closure.effective_cleanup_status === 'succeeded' &&
        closure.effective_leak_audit_status === 'clean' &&
        closure.effective_lease_status === 'released',
      'OPERATIONAL_CLOSURE_NOT_CLEAN',
      `effective cleanup ${closure.effective_cleanup_status}, leak audit ${closure.effective_leak_audit_status}, lease ${closure.effective_lease_status}; expected succeeded, clean and released`,
    ),
    unmet(
      input.safety_status !== 'breached',
      'KNOWN_SAFETY_BREACH',
      'safety_status is breached; expected no known safety breach',
    ),
    unmet(
      input.package_eligibility === 'eligible',
      'PACKAGE_NOT_VERIFIED',
      `package_eligibility is ${input.package_eligibility}; expected eligible for the selected original index and head`,
    ),
    unmet(
      input.transport_scope_snapshot_sha256 !== undefined,
      'NO_TRANSPORT_SCOPE_SNAPSHOT',
      'admission/transport-scope-snapshot.json is absent, unindexed or unreadable; expected an indexed transport-scope snapshot',
    ),
  ].filter((reason) => reason !== undefined);
}

function lateEvidenceRow(status: LateEvidenceStatus): ProbeUnusabilityReason | undefined {
  if (status === 'none' || status === 'consistent') {
    return undefined;
  }
  const code = status === 'contradictory' ? 'LATE_EVIDENCE_CONTRADICTORY' : 'LATE_EVIDENCE_UNVERIFIED';
  return { code, subject: SUBJECT, detail: `effective late_evidence_status is ${status}; expected none or consistent` };
}

function unmet(holds: boolean, code: ProbeUnusabilityCode, detail: string): ProbeUnusabilityReason | undefined {
  return holds ? undefined : { code, subject: SUBJECT, detail };
}

function outcomeOf(reasons: readonly ProbeUnusabilityReason[]): ProbeUsabilityOutcome {
  const [first, ...rest] = reasons;
  return first === undefined
    ? { probe_usability: 'usable', reasons: [] }
    : { probe_usability: 'not_usable', reasons: [first, ...rest] };
}
