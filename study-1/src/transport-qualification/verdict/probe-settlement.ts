// Settlement of the probe (BR-RUA-032, design §8.11). The probe's evidence is verified only when
// settlement under the probe policy is established. As for a trial's gate G6, the judgement is
// re-derived from the frozen settlement samples with the shared evaluator, under the OR-RUA-004
// probe policy, counting the observation deadline from the runner's `probe_workload_invoked` (the
// probe's only workload publication); the runner's `settlement_assessed` must be `established` and
// agree with that re-derivation (window, establishment and recheck instants). A runner claim the
// frozen samples do not reproduce leaves the evidence unverified, never verified: the probe trusts
// bytes, not the runner's judgement (evidence/WP-10/decisions.md).

import { eventRef, reasonAt } from '../../evidence-ingestion/gate-assessment.ts';
import type { GateCause } from '../../evidence-ingestion/gate-assessment.ts';
import type { IngestedEvidence } from '../../evidence-ingestion/ingestion-model.ts';
import type { EvidenceRef } from '../../record-contract/evidence-refs.ts';
import type { EstablishedSettlement } from '../../record-contract/records/group-b/settlement_assessed.ts';
import { evaluateSettlement } from '../../settlement/evaluate-settlement.ts';
import { PROBE_SETTLEMENT_POLICY } from '../../settlement/settlement-policy.ts';
import type { SettlementAssessment } from '../../settlement/settlement-policy.ts';
import { incompleteArtifactReason, subjectArtifactState } from '../../treatment-fidelity/subject-artifacts.ts';
import type { SubjectArtifactState } from '../../treatment-fidelity/subject-artifacts.ts';
import { eventsOfType, partitionEvents } from '../../treatment-fidelity/subject-events.ts';
import type { EventOf } from '../../treatment-fidelity/subject-events.ts';

const SUBJECT = 'BR-RUA-032';

/** What the probe's settlement judgement reads. */
interface ProbeSettlementFacts {
  readonly samples: SubjectArtifactState;
  readonly runner: SubjectArtifactState;
  /** The first workload invocation: the observation deadline counts from it. */
  readonly invoked: EventOf<'probe_workload_invoked'> | undefined;
  readonly assessed: EventOf<'settlement_assessed'> | undefined;
}

/**
 * The causes that keep the probe's settlement from being established; none when the runner's
 * established judgement is the one the frozen samples re-derive.
 *
 * @example
 * probeSettlementCauses(probeEvidence); // [] when the samples re-derive the runner's settlement
 */
export function probeSettlementCauses(evidence: IngestedEvidence): readonly GateCause[] {
  const events = partitionEvents(evidence);
  const facts: ProbeSettlementFacts = {
    samples: subjectArtifactState(evidence, 'settlement_samples'),
    runner: subjectArtifactState(evidence, 'runner_journal'),
    invoked: eventsOfType(events, 'probe_workload_invoked')[0],
    assessed: eventsOfType(events, 'settlement_assessed').at(-1),
  };
  const missing = missingCauses(facts);
  const { assessed, invoked } = facts;
  if (assessed === undefined) {
    return missing;
  }
  if (assessed.record.status !== 'established') {
    const ref = eventRef(assessed);
    const detail = `settlement_assessed ${assessed.record.event_id} is ${assessed.record.status}; expected established`;
    return [
      ...missing,
      { value: 'unverified', reason: reasonAt(SUBJECT, 'SETTLEMENT_NOT_ESTABLISHED', detail, ref), refs: [ref] },
    ];
  }
  if (missing.length > 0 || invoked === undefined) {
    return missing;
  }
  const samples = evidence.observations.settlement_samples.map((located) => located.record);
  const derived = evaluateSettlement(samples, PROBE_SETTLEMENT_POLICY, invoked.record.occurred_at);
  const at = eventRef(assessed);
  return rederivationCauses(derived, assessed.record, at, [...refsOf(facts.samples), eventRef(invoked), at]);
}

// Partial samples could only disagree with the runner spuriously, so they stop the re-derivation;
// a missing runner journal is named once, not once per runner event it would have held.
function missingCauses(facts: ProbeSettlementFacts): readonly GateCause[] {
  const causes = facts.samples.complete ? [] : [incompleteCause(facts.samples)];
  const runnerRef = facts.runner.ref;
  if (runnerRef === undefined) {
    return [...causes, incompleteCause(facts.runner)];
  }
  if (facts.invoked === undefined) {
    causes.push(runnerEventCause(runnerRef, 'WORKLOAD_INVOCATION_NOT_RECORDED', 'probe_workload_invoked'));
  }
  if (facts.assessed === undefined) {
    causes.push(runnerEventCause(runnerRef, 'SETTLEMENT_NOT_ASSESSED', 'settlement_assessed'));
  }
  return causes;
}

function rederivationCauses(
  derived: SettlementAssessment,
  runner: EstablishedSettlement,
  at: EvidenceRef,
  refs: readonly EvidenceRef[],
): readonly GateCause[] {
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
      : `not established (${derived.reasons.map((reason) => reason.code).join(', ')})`;
  const detail = `the runner assessed established ${runner.window_start}..${runner.established_at}, rechecked ${runner.rechecked_at}; the frozen samples re-derive ${rederived} under the probe policy; expected the same judgement`;
  const reason = reasonAt(SUBJECT, 'SETTLEMENT_REDERIVATION_MISMATCH', detail, at);
  return [{ value: 'unverified', reason, refs }];
}

function runnerEventCause(runnerRef: EvidenceRef, code: string, recordType: string): GateCause {
  const detail = `the runner journal has no ${recordType} for the probe; expected the runner's record`;
  return { value: 'unverified', reason: reasonAt(SUBJECT, code, detail, runnerRef), refs: [runnerRef] };
}

function incompleteCause(state: SubjectArtifactState): GateCause {
  return { value: 'unverified', reason: incompleteArtifactReason(state, SUBJECT), refs: refsOf(state) };
}

function refsOf(state: SubjectArtifactState): readonly EvidenceRef[] {
  return state.ref === undefined ? [] : [state.ref];
}
