// Gate G6 `settlement` (BR-RUA-032, design §8.3, D-17, D-32): verified only when the frozen
// samples re-derive an established settlement, the runner's `settlement_assessed` agrees with it
// (status and the window, establishment and recheck instants), and a processing terminal reason is
// derivable. The runner claiming `established` against a different re-derivation is invalid; a
// settlement not established by the deadline (AC-RUA-007 case 2), missing samples, an unknown
// publication or assessment, or a null terminal reason leaves the gate unverified.

import { assembleGate, eventRef, reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { GateCause } from '../evidence-ingestion/gate-assessment.ts';
import type { GateAssessment } from '../evidence-ingestion/ingestion-model.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { SettlementAssessment } from '../settlement/settlement-policy.ts';
import { incompleteArtifactReason } from '../treatment-fidelity/subject-artifacts.ts';
import type { SubjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';
import type { EventOf } from '../treatment-fidelity/subject-events.ts';
import type { TerminalReasonDerivation } from './processing-terminal-reason.ts';
import type { TrialSettlement } from './trial-settlement.ts';

const SUBJECT = 'BR-RUA-032';

/**
 * Judges G6 from the trial's settlement facts and its terminal-reason derivation.
 *
 * @example
 * assessSettlementGate(readTrialSettlement(evidence), deriveProcessingTerminalReason(evidence)).value; // 'verified'
 */
export function assessSettlementGate(
  settlement: TrialSettlement,
  terminal: TerminalReasonDerivation,
): GateAssessment<'settlement'> {
  const terminalCauses: readonly GateCause[] = terminal.reasons.map((reason) => ({
    value: 'unverified',
    reason,
    refs: terminal.evidence_refs,
  }));
  const { derived, published, assessed } = settlement;
  if (derived === undefined || published === undefined || assessed === undefined) {
    return assembleGate('settlement', [...missingCauses(settlement), ...terminalCauses], []);
  }
  const refs = [...refsOf(settlement.samples), eventRef(published), eventRef(assessed)];
  const causes = [...judgementCauses(derived, assessed, refs), ...terminalCauses];
  return assembleGate('settlement', causes, [...refs, ...terminal.evidence_refs]);
}

function missingCauses(settlement: TrialSettlement): readonly GateCause[] {
  const causes: GateCause[] = [];
  if (!settlement.samples.complete) {
    causes.push(incompleteCause(settlement.samples));
  }
  if (settlement.published === undefined) {
    causes.push(runnerCause(settlement.runner_journal, 'PUBLICATION_NOT_RECORDED', 'trial_message_published'));
  }
  if (settlement.assessed === undefined) {
    causes.push(runnerCause(settlement.runner_journal, 'SETTLEMENT_NOT_ASSESSED', 'settlement_assessed'));
  }
  return causes;
}

function judgementCauses(
  derived: SettlementAssessment,
  assessed: EventOf<'settlement_assessed'>,
  refs: readonly EvidenceRef[],
): readonly GateCause[] {
  const runner = assessed.record;
  const at = eventRef(assessed);
  if (runner.status === 'established') {
    const agrees =
      derived.status === 'established' &&
      derived.window_start === runner.window_start &&
      derived.established_at === runner.established_at &&
      derived.rechecked_at === runner.rechecked_at;
    if (agrees) {
      return [];
    }
    const rederived =
      derived.status === 'established'
        ? `established ${derived.window_start}..${derived.established_at}, rechecked ${derived.rechecked_at}`
        : 'not established';
    const detail = `the runner assessed established ${runner.window_start}..${runner.established_at}, rechecked ${runner.rechecked_at}; the frozen samples re-derive ${rederived}; expected the same judgement`;
    return [{ value: 'invalid', reason: reasonAt(SUBJECT, 'SETTLEMENT_REDERIVATION_MISMATCH', detail, at), refs }];
  }
  if (derived.status === 'established') {
    const detail = `the runner assessed not_established although the samples re-derive established at ${derived.established_at}; expected an established assessment`;
    return [{ value: 'unverified', reason: reasonAt(SUBJECT, 'SETTLEMENT_NOT_ESTABLISHED', detail, at), refs }];
  }
  return derived.reasons.map((reason) => ({
    value: 'unverified',
    reason: reasonAt(reason.subject, reason.code, reason.detail, at),
    refs,
  }));
}

function runnerCause(runner: SubjectArtifactState, code: string, recordType: string): GateCause {
  if (runner.ref === undefined) {
    return incompleteCause(runner);
  }
  const detail = `the runner journal has no ${recordType} for the trial; expected the runner's record`;
  return { value: 'unverified', reason: reasonAt(SUBJECT, code, detail, runner.ref), refs: [runner.ref] };
}

function incompleteCause(state: SubjectArtifactState): GateCause {
  return { value: 'unverified', reason: incompleteArtifactReason(state, SUBJECT), refs: refsOf(state) };
}

function refsOf(state: SubjectArtifactState): readonly EvidenceRef[] {
  return state.ref === undefined ? [] : [state.ref];
}
