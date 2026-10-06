// Group-C examples of the transport probe: its frozen result, its summary and the verifier's
// usability assessment (catalogue rows 69, 70 and 81).

import type { ProbeUsabilityAssessment } from '../../../../../src/record-contract/records/group-c/probe_usability_assessment.ts';
import type { TransportProbeResult } from '../../../../../src/record-contract/records/group-c/transport_probe_result.ts';
import type { TransportProbeSummary } from '../../../../../src/record-contract/records/group-c/transport_probe_summary.ts';
import { EXECUTION_MANIFEST_SHA256, PROBE_ID, at, digest, reason } from '../../group-b/support/record-builders.ts';
import {
  PROBE_DIRECTORY,
  PROBE_PATHS,
  artifactRef,
  codedReason,
  evidenceRef,
  sixConditions,
} from '../support/group-c-builders.ts';
import { groupCExample } from '../support/record-example.ts';
import type { GroupCExample } from '../support/record-example.ts';

const PROBE_RESULT_PATH = 'probe/derived/transport-probe-result.json';

/**
 * A passing probe: valid, verified evidence and six passing conditions (CTR-RUA-003).
 *
 * @example
 * passingTransportProbeResult().transport_probe_verdict; // 'pass'
 */
export function passingTransportProbeResult(): TransportProbeResult {
  return {
    schema_version: 1,
    record_type: 'transport_probe_result',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    transport_probe_verdict: 'pass',
    probe_validity: 'valid',
    probe_cardinality: { caller_invocations: 1, accepted_provider_calls: 1, committed_transactions: 1 },
    evidence_integrity: 'verified',
    treatment_fidelity: 'verified',
    fidelity_basis: 'causal_plus_cross_source_clock_assumption',
    clock_assumption_refs: ['CA-1'],
    ordering_basis: 'cross_source_wall_clock',
    condition_results: sixConditions('pass', undefined, PROBE_DIRECTORY),
    evidence_refs: [evidenceRef(PROBE_PATHS.providerJournal)],
    indeterminate_reasons: [],
    checked_at: at(2000),
  };
}

/**
 * An invalid probe: a second caller invocation (design §8.11) makes it indeterminate whatever its
 * conditions say (BR-RUA-027). Its unaffected failing conditions make treatment fidelity invalid
 * (design §8.10), and it keeps the D-05 basis under CA-1.
 *
 * @example
 * invalidTransportProbeResult().transport_probe_verdict; // 'indeterminate'
 */
export function invalidTransportProbeResult(): TransportProbeResult {
  return {
    ...passingTransportProbeResult(),
    transport_probe_verdict: 'indeterminate',
    probe_validity: 'invalid',
    probe_cardinality: { caller_invocations: 2, accepted_provider_calls: 0, committed_transactions: 0 },
    evidence_integrity: 'unverified',
    treatment_fidelity: 'invalid',
    condition_results: sixConditions('fail', ['BR-RUA-011', 'indeterminate'], PROBE_DIRECTORY),
    evidence_refs: [],
    indeterminate_reasons: [reason('PROBE_CARDINALITY_INVALID', 'probe workload')],
  };
}

/**
 * A failing probe (AC-RUA-031): a valid probe with the expected cardinality whose commit and timer
 * timestamps are reversed, so BR-RUA-010 fails on unaffected evidence (design §8.10:
 * `committed_at > timer_fired_at`) while the other five conditions pass. The unaffected failure
 * makes the verdict `fail` and treatment fidelity `invalid`.
 *
 * @example
 * failingTransportProbeResult().transport_probe_verdict; // 'fail'
 */
export function failingTransportProbeResult(): TransportProbeResult {
  return {
    ...passingTransportProbeResult(),
    transport_probe_verdict: 'fail',
    probe_validity: 'valid',
    treatment_fidelity: 'invalid',
    condition_results: sixConditions('pass', ['BR-RUA-010', 'fail'], PROBE_DIRECTORY),
  };
}

/**
 * A probe whose lifecycle COMPLETED with a clean closure; it carries the probe-result digest.
 *
 * @example
 * transportProbeSummary().probe_result_sha256; // digest of the frozen probe result
 */
export function transportProbeSummary(): TransportProbeSummary {
  return {
    schema_version: 1,
    record_type: 'transport_probe_summary',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    probe_terminal_reason: 'COMPLETED',
    cleanup_status: 'succeeded',
    leak_audit_status: 'clean',
    lease_status: 'released',
    safety_status: 'within_limits',
    probe_result_sha256: digest(PROBE_RESULT_PATH),
    late_evidence_status: 'none',
    late_evidence_assessment_ref: artifactRef('late-evidence/late-evidence-assessment.json'),
    created_at: at(2100),
  };
}

/**
 * A probe that satisfies every usability condition (BR-RUA-026, AC-RUA-056).
 *
 * @example
 * usableProbe().probe_usability; // 'usable'
 */
export function usableProbe(): ProbeUsabilityAssessment {
  return {
    schema_version: 1,
    record_type: 'probe_usability_assessment',
    transport_probe_id: PROBE_ID,
    original_package_index_sha256: digest('probe-package-index'),
    selected_amendment_head_sha256: null,
    probe_usability: 'usable',
    reasons: [],
    transport_probe_verdict: 'pass',
    probe_validity: 'valid',
    treatment_fidelity: 'verified',
    evidence_integrity: 'verified',
    late_evidence_status: 'consistent',
    effective_cleanup_status: 'succeeded',
    effective_leak_audit_status: 'clean',
    effective_lease_status: 'released',
    safety_status: 'unverified',
    package_eligibility: 'eligible',
    transport_scope_snapshot_sha256: digest('transport-scope-snapshot'),
    evidence_refs: [evidenceRef(PROBE_RESULT_PATH, { package_index_sha256: digest('probe-package-index') })],
    assessed_at: at(2200),
  };
}

/**
 * A probe whose late evidence contradicts it and whose closure is not clean.
 *
 * @example
 * unusableProbe().reasons.length; // 2
 */
export function unusableProbe(): ProbeUsabilityAssessment {
  return {
    ...usableProbe(),
    selected_amendment_head_sha256: digest('probe-amendment-1'),
    probe_usability: 'not_usable',
    reasons: [
      codedReason('LATE_EVIDENCE_CONTRADICTORY', 'late evidence'),
      codedReason('OPERATIONAL_CLOSURE_NOT_CLEAN', 'leak audit'),
    ],
    late_evidence_status: 'contradictory',
    effective_leak_audit_status: 'leaks_detected',
  };
}

export const PROBE_EXAMPLES: readonly GroupCExample[] = [
  groupCExample('transport_probe_result', passingTransportProbeResult()),
  groupCExample('transport_probe_result (invalid)', invalidTransportProbeResult()),
  groupCExample('transport_probe_result (fail)', failingTransportProbeResult()),
  groupCExample('transport_probe_summary', transportProbeSummary()),
  groupCExample('probe_usability_assessment', usableProbe()),
  groupCExample('probe_usability_assessment (not usable)', unusableProbe(), ['transport_scope_snapshot_sha256']),
];
