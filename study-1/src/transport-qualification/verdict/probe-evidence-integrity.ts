// Evidence integrity of the probe (design §8.11): `invalid` if evidence integrity (G8),
// traceability (G2), identity integrity (G3) or ledger access (G5) is invalid; `unverified` if any
// of them is unverified or settlement under the probe policy is not established; `verified`
// otherwise.
//
// A workload count of 0 also leaves the evidence unverified: AC-RUA-021 makes the expected
// cardinality part of a `pass`, BR-RUA-027 leaves zero counts to the conditions (which may still
// fail conclusively, and a `fail` precedes evidence in the verdict), and the result schema admits a
// `pass` only with cardinality 1/1/1 (evidence/WP-10/decisions.md).

import { assessEvidenceIntegrity } from '../../evidence-ingestion/evidence-integrity-gate.ts';
import type { GateCause } from '../../evidence-ingestion/gate-assessment.ts';
import { assessIdentityIntegrity } from '../../evidence-ingestion/identity-integrity-gate.ts';
import type { GateAssessment, IngestedEvidence } from '../../evidence-ingestion/ingestion-model.ts';
import { assessTraceability } from '../../evidence-ingestion/traceability-gate.ts';
import type { EvidenceRef } from '../../record-contract/evidence-refs.ts';
import type { GateId } from '../../record-contract/records/group-c/vocabulary.ts';
import { assembleApplicableGate } from '../../treatment-fidelity/applicable-gate.ts';
import type { ApplicableGate } from '../../treatment-fidelity/applicable-gate.ts';
import { assessProbeLedgerAccess } from './probe-ledger-access.ts';
import { probeSettlementCauses } from './probe-settlement.ts';
import type { ProbeValidityAssessment } from './probe-validity.ts';

/**
 * Judges the probe's evidence integrity from the ingestion gates, ledger access, settlement and
 * the counted workload.
 *
 * @example
 * assessProbeEvidenceIntegrity(probeEvidence, assessProbeValidity(probeEvidence)).value; // 'verified'
 */
export function assessProbeEvidenceIntegrity(
  evidence: IngestedEvidence,
  validity: ProbeValidityAssessment,
): ApplicableGate<'evidence_integrity'> {
  const gates: readonly GateAssessment<GateId>[] = [
    assessEvidenceIntegrity(evidence),
    assessTraceability(evidence),
    assessIdentityIntegrity(evidence),
    assessProbeLedgerAccess(evidence),
  ];
  const causes = [...gates.flatMap(gateCauses), ...probeSettlementCauses(evidence), ...workloadCauses(validity)];
  const verifiedRefs = gates.flatMap((gate) => gate.evidence_refs);
  return assembleApplicableGate('evidence_integrity', causes, verifiedRefs);
}

// A gate's own reasons carry its value into the probe's integrity; a verified or not-applicable
// gate contributes nothing.
function gateCauses(gate: GateAssessment<GateId>): readonly GateCause[] {
  const value = gate.value;
  if (value !== 'invalid' && value !== 'unverified') {
    return [];
  }
  return gate.reasons.map((reason) => ({ value, reason, refs: gate.evidence_refs }));
}

function workloadCauses(validity: ProbeValidityAssessment): readonly GateCause[] {
  const counts = Object.entries(validity.cardinality).filter(([, count]) => count === 0);
  const refs: readonly EvidenceRef[] = validity.evidence_refs;
  return counts.map(([field]) => ({
    value: 'unverified',
    reason: {
      code: 'PROBE_WORKLOAD_NOT_EVIDENCED',
      subject: 'BR-RUA-027',
      detail: `${field} is 0; expected exactly 1 evidenced by the probe's journals and ledger`,
    },
    refs,
  }));
}
