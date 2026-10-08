// A gate that always applies to its subject: treatment fidelity of a treatment trial or the probe,
// and the probe's evidence integrity. Its value is never `not_applicable`, which is what the
// result records (`transport_probe_result`) require; the reasons and references come from the
// shared gate assembly (design §8.3: `invalid` wins over `unverified`, which wins over `verified`).

import { assembleGate } from '../evidence-ingestion/gate-assessment.ts';
import type { GateCause } from '../evidence-ingestion/gate-assessment.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { ApplicableGateValue, GateId } from '../record-contract/records/group-c/vocabulary.ts';

export interface ApplicableGate<G extends GateId> {
  readonly gate: G;
  readonly value: ApplicableGateValue;
  readonly reasons: readonly StructuredReason[];
  readonly evidence_refs: readonly EvidenceRef[];
}

/**
 * Assembles an always-applicable gate from its causes.
 *
 * @example
 * assembleApplicableGate('treatment_fidelity', [], refs).value; // 'verified'
 */
export function assembleApplicableGate<G extends GateId>(
  gate: G,
  causes: readonly GateCause[],
  verifiedRefs: readonly EvidenceRef[],
): ApplicableGate<G> {
  const assembled = assembleGate(gate, causes, verifiedRefs);
  const value = causes.some((cause) => cause.value === 'invalid')
    ? 'invalid'
    : causes.length > 0
      ? 'unverified'
      : 'verified';
  return { gate, value, reasons: assembled.reasons, evidence_refs: assembled.evidence_refs };
}
