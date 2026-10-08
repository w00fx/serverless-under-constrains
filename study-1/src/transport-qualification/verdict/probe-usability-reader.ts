// Reads the facts BR-RUA-026 judges from a stored probe package and its explicitly selected
// amendment chain (design §8.11, §8.16; AC-RUA-056), for `assessProbeUsability`:
// - package eligibility comes from the package verifier over the original index and the head;
// - the verdict, validity, fidelity and integrity come from the frozen probe result, read only
//   when its bytes are the ones the summary's `probe_result_sha256` names;
// - the effective closure is the summary's closure after the selected operational recoveries;
// - the effective late evidence is the last LATE_EVIDENCE or REASSESSMENT assessment of the
//   selected chain, else the summary's (an unreadable selected assessment is unverified);
// - safety is the summary's, made `breached` by any selected billing import that is breached;
// - the transport-scope snapshot counts only when it is stored, listed by the package index and
//   reads as a valid snapshot.
// Every reference points into the original package and names its index digest (BR-RUA-035).

import { effectiveOperationalState } from '../../evidence-package/effective-operational-state.ts';
import { EXECUTION_PATHS, AMENDMENT_PATHS, PACKAGE_LAYOUT } from '../../evidence-package/package-layout.ts';
import { verifyPackage } from '../../evidence-package/package-verifier.ts';
import type { PackageVerificationInput } from '../../evidence-package/package-verifier.ts';
import type { EvidenceRef } from '../../record-contract/evidence-refs.ts';
import type { ExecutionIdentity, Sha256Hex } from '../../record-contract/primitives.ts';
import type { TransportScopeSnapshot } from '../../record-contract/records/group-a/transport_scope_snapshot.ts';
import type { SafetyResult } from '../../record-contract/records/group-b/vocabulary.ts';
import type { PackageVerification } from '../../record-contract/records/group-c/package_verification.ts';
import type { TransportProbeResult } from '../../record-contract/records/group-c/transport_probe_result.ts';
import type { TransportProbeSummary } from '../../record-contract/records/group-c/transport_probe_summary.ts';
import type { LateEvidenceStatus } from '../../record-contract/records/group-c/vocabulary.ts';
import { readAmendmentRecord, readProbeRecord } from './probe-package-records.ts';
import type { ProbeRecordDeps, StoredProbeRecord } from './probe-package-records.ts';
import type { EffectiveClosure, ProbeOutcomeFacts, ProbeUsabilityInput } from './probe-usability.ts';

/** The package of one transport probe, its amendments and the operator's explicit selection. */
export interface ProbePackageInput extends PackageVerificationInput {
  readonly identity: Extract<ExecutionIdentity, { readonly execution_kind: 'TRANSPORT_PROBE' }>;
}

/** What a probe result that cannot be read leaves known: nothing conclusive. */
const UNKNOWN_PROBE: ProbeOutcomeFacts = {
  transport_probe_verdict: 'indeterminate',
  probe_validity: 'indeterminate',
  treatment_fidelity: 'unverified',
  evidence_integrity: 'unverified',
};

const UNVERIFIED_CLOSURE: EffectiveClosure = {
  effective_cleanup_status: 'unverified',
  effective_leak_audit_status: 'unverified',
  effective_lease_status: 'unverified',
};

const PROBE_RESULT_PATH = PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, 'transportProbeResult');

/**
 * Reads the usability facts of a stored probe package.
 *
 * @example
 * const facts = readProbeUsabilityInput({ identity, original, amendments, selected_head: null,
 *   referenced_package_indexes: [], evaluated_at }, { validator, digest: sha256Hex });
 * assessProbeUsability(facts).probe_usability; // 'usable' | 'not_usable'
 */
export function readProbeUsabilityInput(input: ProbePackageInput, deps: ProbeRecordDeps): ProbeUsabilityInput {
  const verification = verifyPackage(input, deps);
  const files = input.original.files;
  const summary = readProbeRecord(files, EXECUTION_PATHS.transportProbeSummary, 'transport_probe_summary', deps);
  const result = frozenResult(input, summary?.record, deps);
  const scope = indexedScopeSnapshot(input, deps);
  const indexDigest = verification.original_package_index_sha256;
  const refs = [
    storedRef(EXECUTION_PATHS.transportProbeSummary, summary, indexDigest),
    storedRef(PROBE_RESULT_PATH, result, indexDigest),
    storedRef(EXECUTION_PATHS.transportScopeSnapshot, scope, indexDigest),
  ].filter((ref) => ref !== undefined);
  return {
    transport_probe_id: input.identity.transport_probe_id,
    original_package_index_sha256: verification.original_package_index_sha256,
    selected_amendment_head_sha256: verification.selected_amendment_head_sha256,
    probe: result === undefined ? UNKNOWN_PROBE : outcomeFacts(result.record),
    late_evidence_status: lateEvidenceStatus(verification, input, summary?.record, deps),
    closure: effectiveClosure(verification, input, summary?.record, deps),
    safety_status: safetyStatus(verification, input, summary?.record, deps),
    package_eligibility: verification.package_eligibility,
    ...(scope === undefined ? {} : { transport_scope_snapshot_sha256: scope.sha256 }),
    evidence_refs: refs,
    assessed_at: input.evaluated_at,
  };
}

function storedRef(
  path: string,
  stored: StoredProbeRecord<unknown> | undefined,
  packageIndexDigest: Sha256Hex,
): EvidenceRef | undefined {
  return stored === undefined
    ? undefined
    : { artifact_path: path, artifact_sha256: stored.sha256, package_index_sha256: packageIndexDigest };
}

// The frozen result is the one whose exact bytes the summary names; any other bytes at that path
// are not the result the lifecycle froze.
function frozenResult(
  input: ProbePackageInput,
  summary: TransportProbeSummary | undefined,
  deps: ProbeRecordDeps,
): StoredProbeRecord<TransportProbeResult> | undefined {
  const result = readProbeRecord(input.original.files, PROBE_RESULT_PATH, 'transport_probe_result', deps);
  const frozen =
    result !== undefined &&
    summary?.probe_result_sha256 === result.sha256 &&
    result.record.transport_probe_id === input.identity.transport_probe_id;
  return frozen ? result : undefined;
}

function outcomeFacts(result: TransportProbeResult): ProbeOutcomeFacts {
  return {
    transport_probe_verdict: result.transport_probe_verdict,
    probe_validity: result.probe_validity,
    treatment_fidelity: result.treatment_fidelity,
    evidence_integrity: result.evidence_integrity,
  };
}

function indexedScopeSnapshot(
  input: ProbePackageInput,
  deps: ProbeRecordDeps,
): StoredProbeRecord<TransportScopeSnapshot> | undefined {
  const path = EXECUTION_PATHS.transportScopeSnapshot;
  const index = readProbeRecord(input.original.files, EXECUTION_PATHS.packageIndex, 'package_index', deps);
  const indexed = index?.record.entries.some((entry) => entry.artifact_path === path) === true;
  return indexed ? readProbeRecord(input.original.files, path, 'transport_scope_snapshot', deps) : undefined;
}

function lateEvidenceStatus(
  verification: PackageVerification,
  input: ProbePackageInput,
  summary: TransportProbeSummary | undefined,
  deps: ProbeRecordDeps,
): LateEvidenceStatus {
  const link = verification.selected_chain.findLast(
    (candidate) => candidate.amendment_kind === 'LATE_EVIDENCE' || candidate.amendment_kind === 'REASSESSMENT',
  );
  if (link === undefined) {
    return summary?.late_evidence_status ?? 'unverified';
  }
  const assessment = readAmendmentRecord(
    link.amendment_index_sha256,
    input.amendments,
    AMENDMENT_PATHS.lateEvidenceAssessment,
    'late_evidence_assessment',
    deps,
  );
  return assessment?.late_evidence_status ?? 'unverified';
}

function effectiveClosure(
  verification: PackageVerification,
  input: ProbePackageInput,
  summary: TransportProbeSummary | undefined,
  deps: ProbeRecordDeps,
): EffectiveClosure {
  if (summary === undefined) {
    return UNVERIFIED_CLOSURE;
  }
  const original_closure = {
    cleanup_status: summary.cleanup_status,
    leak_audit_status: summary.leak_audit_status,
    lease_status: summary.lease_status,
  };
  const state = effectiveOperationalState({ verification, original_closure, amendments: input.amendments }, deps);
  return {
    effective_cleanup_status: state.effective_cleanup_status,
    effective_leak_audit_status: state.effective_leak_audit_status,
    effective_lease_status: state.effective_lease_status,
  };
}

// A billing import is a safety finding: a selected import that is breached makes a breach known;
// no import ever clears one.
function safetyStatus(
  verification: PackageVerification,
  input: ProbePackageInput,
  summary: TransportProbeSummary | undefined,
  deps: ProbeRecordDeps,
): SafetyResult {
  const breachedBill = verification.selected_chain
    .filter((link) => link.amendment_kind === 'BILLING')
    .some(
      (link) =>
        readAmendmentRecord(
          link.amendment_index_sha256,
          input.amendments,
          AMENDMENT_PATHS.billingImport,
          'billing_import',
          deps,
        )?.billed_cost_check === 'breached',
    );
  return breachedBill ? 'breached' : (summary?.safety_status ?? 'unverified');
}
