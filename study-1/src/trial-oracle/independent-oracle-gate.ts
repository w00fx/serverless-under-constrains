// Gate G1 `independent_oracle` (BR-RUA-005, design §8.3): the monetary rules may read only a
// ledger snapshot the evidence collector wrote with a consistent read, captured inside the settled
// window `[established_at, rechecked_at]` of the trial's settlement. A snapshot that declares an
// inconsistent read or another writer is invalid; a missing or unreadable snapshot, an unsettled
// trial, or a capture outside the window leaves the gate unverified.

import { assembleGate, reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { GateCause } from '../evidence-ingestion/gate-assessment.ts';
import type { GateAssessment, IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import { incompleteArtifactReason, subjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';
import type { TrialSettlement } from './trial-settlement.ts';

const SUBJECT = 'BR-RUA-005';
const COLLECTOR = 'evidence_collector';

/**
 * Judges G1 over the trial's ledger snapshot and its settlement.
 *
 * @example
 * assessIndependentOracle(evidence, readTrialSettlement(evidence)).value; // 'verified'
 */
export function assessIndependentOracle(
  evidence: IngestedEvidence,
  settlement: TrialSettlement,
): GateAssessment<'independent_oracle'> {
  const state = subjectArtifactState(evidence, 'ledger_snapshot');
  const snapshot = evidence.ledger.snapshot?.record;
  const refs: readonly EvidenceRef[] = state.ref === undefined ? [] : [state.ref];
  if (snapshot === undefined) {
    const cause: GateCause = { value: 'unverified', reason: incompleteArtifactReason(state, SUBJECT), refs };
    return assembleGate('independent_oracle', [cause], []);
  }
  const causes: GateCause[] = [];
  if (!snapshot.consistent_read) {
    const detail = 'the ledger snapshot declares consistent_read false; expected a strongly consistent read';
    causes.push({ value: 'invalid', reason: reasonAt(SUBJECT, 'LEDGER_READ_NOT_CONSISTENT', detail, state.ref), refs });
  }
  if (snapshot.writer !== COLLECTOR) {
    const detail = `the ledger snapshot was written by ${snapshot.writer}; expected ${COLLECTOR}`;
    causes.push({ value: 'invalid', reason: reasonAt(SUBJECT, 'LEDGER_NOT_INDEPENDENT', detail, state.ref), refs });
  }
  causes.push(...captureCauses(snapshot.captured_at, settlement, state.ref, refs));
  return assembleGate('independent_oracle', causes, refs);
}

function captureCauses(
  capturedAt: string,
  settlement: TrialSettlement,
  ledgerRef: EvidenceRef | undefined,
  refs: readonly EvidenceRef[],
): readonly GateCause[] {
  const derived = settlement.derived;
  if (derived?.status !== 'established') {
    const detail = `the ledger snapshot captured at ${capturedAt} has no settled window to lie in; expected a capture after settlement was established`;
    return [{ value: 'unverified', reason: reasonAt(SUBJECT, 'SETTLEMENT_NOT_ESTABLISHED', detail, ledgerRef), refs }];
  }
  const captured = Date.parse(capturedAt);
  if (captured >= Date.parse(derived.established_at) && captured <= Date.parse(derived.rechecked_at)) {
    return [];
  }
  const detail = `the ledger snapshot was captured at ${capturedAt}; expected an instant in [${derived.established_at}, ${derived.rechecked_at}]`;
  return [
    {
      value: 'unverified',
      reason: reasonAt(SUBJECT, 'LEDGER_CAPTURED_OUTSIDE_SETTLED_WINDOW', detail, ledgerRef),
      refs,
    },
  ];
}
