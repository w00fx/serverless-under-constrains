// Control integrity, gate G4a (BR-RUA-025, design §8.3; AC-RUA-029). A control trial is verified
// only when its immutable provider configuration declares CONTROL, treatment was never armed or
// consumed, no treatment transition occurred, and every accepted provider call has a caller
// outcome SUCCEEDED or REJECTED, with no timeout anywhere in the partition. Multiple provider calls
// do not by themselves invalidate it: monetary rules judge their effects. A treatment trial or the
// probe is judged by treatment fidelity instead, so G4a is `not_applicable` there.

import { assembleGate, reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { GateCause } from '../evidence-ingestion/gate-assessment.ts';
import type { GateAssessment, IndexedEvent, IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { EventRecordType } from '../record-contract/record-types.ts';
import { refOf } from './condition-result.ts';
import { eventsOfType, isCallerEvent, partitionEvents } from './subject-events.ts';
import { incompleteArtifactReason, subjectArtifactState } from './subject-artifacts.ts';
import type { SubjectArtifactState } from './subject-artifacts.ts';

const SUBJECT = 'BR-RUA-025';
/** Events only a treatment protocol writes: each is a treatment transition (or its arming). */
const TREATMENT_EVENT_TYPES: readonly EventRecordType[] = [
  'treatment_armed',
  'timeout_signal_recorded',
  'timeout_signal_conflict_recorded',
  'treatment_timeout_observed',
  'treatment_response_released',
  'treatment_safety_released',
];

/**
 * Derives G4a for a CONTROL trial; `not_applicable` for a treatment trial or the probe.
 *
 * @example
 * deriveControlIntegrity(ingestEvidence(controlInput, validator)).value; // 'verified'
 */
export function deriveControlIntegrity(evidence: IngestedEvidence): GateAssessment<'control_integrity'> {
  if (evidence.scope.subject_kind === 'probe' || evidence.scope.trial?.scenario === 'COMMIT_THEN_TIMEOUT') {
    return { gate: 'control_integrity', value: 'not_applicable', reasons: [], evidence_refs: [] };
  }
  const events = partitionEvents(evidence);
  const caller = subjectArtifactState(evidence, 'caller_journal');
  const provider = subjectArtifactState(evidence, 'provider_journal');
  const configuration = subjectArtifactState(evidence, 'provider_trial_configuration');
  const snapshot = subjectArtifactState(evidence, 'treatment_state_snapshot');
  const causes = [
    ...unknownScenarioCauses(evidence),
    ...configurationCauses(evidence, configuration),
    ...snapshotCauses(evidence, snapshot),
    ...treatmentEventCauses(events),
    ...timeoutCauses(events),
    ...[caller, provider].filter((state) => !state.complete).map(incompleteCause),
    ...acceptedCallCauses(events),
  ];
  const verifiedRefs = [configuration.ref, snapshot.ref, caller.ref, provider.ref].filter((ref) => ref !== undefined);
  return assembleGate('control_integrity', causes, verifiedRefs);
}

// Without a usable trial manifest the trial is not known to be a CONTROL trial, so the
// configuration alone cannot verify G4a (evidence/WP-10/decisions.md).
function unknownScenarioCauses(evidence: IngestedEvidence): readonly GateCause[] {
  if (evidence.scope.trial !== undefined) {
    return [];
  }
  const detail = 'the trial scenario is unknown (no usable trial manifest); expected a CONTROL trial manifest';
  return [{ value: 'unverified', reason: reasonAt(SUBJECT, 'TRIAL_SCENARIO_UNKNOWN', detail), refs: [] }];
}

function configurationCauses(evidence: IngestedEvidence, state: SubjectArtifactState): readonly GateCause[] {
  const configuration = evidence.observations.provider_configuration?.record;
  if (configuration === undefined) {
    return [incompleteCause(state)];
  }
  if (configuration.scenario === 'CONTROL') {
    return [];
  }
  const detail = `provider configuration declares scenario ${configuration.scenario}; expected CONTROL`;
  return [invalidAt('CONTROL_SCENARIO_MISMATCH', detail, state)];
}

function snapshotCauses(evidence: IngestedEvidence, state: SubjectArtifactState): readonly GateCause[] {
  const snapshot = evidence.observations.treatment_snapshot?.record;
  if (snapshot === undefined) {
    return [incompleteCause(state)];
  }
  if (snapshot.item_present) {
    const detail = `the partition holds a treatment item in state ${snapshot.treatment.state}; expected no treatment item`;
    return [invalidAt('TREATMENT_ITEM_PRESENT', detail, state)];
  }
  if (snapshot.consistent_read) {
    return [];
  }
  const detail = 'the treatment snapshot declares consistent_read false; expected a consistent read to prove absence';
  return [
    {
      value: 'unverified',
      reason: reasonAt(SUBJECT, 'SNAPSHOT_NOT_CONSISTENT', detail, state.ref),
      refs: refsOf(state.ref),
    },
  ];
}

// Treatment armed, consumed (a targeted commit) or transitioned in a control partition.
function treatmentEventCauses(events: readonly IndexedEvent[]): readonly GateCause[] {
  const targeted = eventsOfType(events, 'provider_transaction_committed').filter((event) => event.record.targeted);
  const treatment = events.filter((event) => TREATMENT_EVENT_TYPES.includes(event.record.record_type));
  return [...targeted, ...treatment].map((event) => {
    const detail = `${event.record.record_type} ${event.record.event_id} in a control partition; expected no treatment arming, consumption or transition`;
    return eventCause('TREATMENT_ACTIVITY', detail, event);
  });
}

function timeoutCauses(events: readonly IndexedEvent[]): readonly GateCause[] {
  const timeouts = eventsOfType(events, 'caller_timeout_recorded').filter(isCallerEvent);
  const timedOut = eventsOfType(events, 'attempt_outcome_recorded').filter(
    (event) => event.record.outcome === 'TIMED_OUT',
  );
  return [...timeouts, ...timedOut].map((event) => {
    const detail = `${event.record.record_type} ${event.record.event_id} for attempt ${String(event.record.attempt_id)}; expected every accepted call to return before its deadline`;
    return eventCause('UNCONTROLLED_TIMEOUT', detail, event);
  });
}

// Every accepted call needs its attempt's conclusive outcome: SUCCEEDED or REJECTED. A TIMED_OUT
// outcome is already an uncontrolled timeout, so it is not counted twice.
function acceptedCallCauses(events: readonly IndexedEvent[]): readonly GateCause[] {
  const outcomes = eventsOfType(events, 'attempt_outcome_recorded');
  return eventsOfType(events, 'provider_call_accepted').flatMap((call) => {
    const outcome = outcomes.find((candidate) => candidate.record.attempt_id === call.record.attempt_id)?.record
      .outcome;
    if (outcome === 'SUCCEEDED' || outcome === 'REJECTED' || outcome === 'TIMED_OUT') {
      return [];
    }
    const detail = `accepted call ${call.record.provider_call_id} of attempt ${call.record.attempt_id} has caller outcome ${outcome ?? '(none)'}; expected SUCCEEDED or REJECTED`;
    const ref = refOf(call);
    return [
      {
        value: 'unverified',
        reason: reasonAt(SUBJECT, 'CALLER_OUTCOME_NOT_CONCLUSIVE', detail, ref),
        refs: refsOf(ref),
      } satisfies GateCause,
    ];
  });
}

function incompleteCause(state: SubjectArtifactState): GateCause {
  return { value: 'unverified', reason: incompleteArtifactReason(state, SUBJECT), refs: refsOf(state.ref) };
}

function invalidAt(code: string, detail: string, state: SubjectArtifactState): GateCause {
  return { value: 'invalid', reason: reasonAt(SUBJECT, code, detail, state.ref), refs: refsOf(state.ref) };
}

function eventCause(code: string, detail: string, event: IndexedEvent): GateCause {
  const ref = refOf(event);
  return { value: 'invalid', reason: reasonAt(SUBJECT, code, detail, ref), refs: refsOf(ref) };
}

function refsOf(ref: EvidenceRef | undefined): readonly EvidenceRef[] {
  return ref === undefined ? [] : [ref];
}
