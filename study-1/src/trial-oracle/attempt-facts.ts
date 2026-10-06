// The physical attempts of the evaluated trial, as the caller journal records them (BR-RUA-020,
// BR-RUA-021, design §8.5 BR-RUA-004 and §8.9). Each `attempt_registered` is one attempt, in
// `occurred_at` order (journal order breaks ties). Its dispatch state comes from the durable
// dispatch evidence (`classifyDispatch`); a SUCCEEDED, REJECTED or TIMED_OUT outcome implies
// DISPATCHED (BR-RUA-021), so it settles a dispatch the records leave UNKNOWN. The outcome class
// comes from `classifyOutcome` over that state. An attempt without an outcome is never a success or rejection (BR-RUA-021): it is a
// pre-dispatch failure when the NOT_DISPATCHED transition is recorded and ambiguous otherwise. An
// outcome that contradicts its dispatch evidence is counted ambiguous and keeps the contradiction.

import type { IndexedEvent, IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import { classifyDispatch } from '../attempt-lifecycle/dispatch-classification.ts';
import { classifyOutcome } from '../attempt-lifecycle/outcome-classification.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { DispatchState } from '../record-contract/records/group-b/vocabulary.ts';
import type { OutcomeClass } from '../record-contract/records/group-c/vocabulary.ts';
import { eventString, eventsOfType, isCallerEvent, partitionEvents } from '../treatment-fidelity/subject-events.ts';
import type { EventOf } from '../treatment-fidelity/subject-events.ts';

export interface AttemptFacts {
  readonly registered: EventOf<'attempt_registered'>;
  /** The caller invocation started in the attempt's source instance, when recorded. */
  readonly invocation?: EventOf<'caller_invocation_started'>;
  readonly dispatch_state: DispatchState;
  readonly outcome?: EventOf<'attempt_outcome_recorded'>;
  readonly outcome_class: OutcomeClass;
  /** Set when the recorded outcome contradicts the dispatch evidence (BR-RUA-021). */
  readonly contradiction?: StructuredReason;
}

/**
 * The trial's attempts in order, with their dispatch and outcome classification.
 *
 * @example
 * readAttempts(evidence).map((attempt) => attempt.outcome_class); // ['AMBIGUOUS', 'SUCCESS']
 */
export function readAttempts(evidence: IngestedEvidence): readonly AttemptFacts[] {
  const callerEvents = partitionEvents(evidence).filter(isCallerEvent);
  const registrations = eventsOfType(callerEvents, 'attempt_registered').toSorted(compareOccurrence);
  return registrations.map((registered) => attemptFacts(callerEvents, registered));
}

function attemptFacts(callerEvents: readonly IndexedEvent[], registered: EventOf<'attempt_registered'>): AttemptFacts {
  const attemptId = registered.record.attempt_id;
  const ofAttempt = callerEvents.filter((event) => eventString(event, 'attempt_id') === attemptId);
  const outcome = eventsOfType(ofAttempt, 'attempt_outcome_recorded')[0];
  const recordedDispatch = classifyDispatch({
    pre_dispatch_registered: true,
    not_dispatched_transition_recorded: eventsOfType(ofAttempt, 'attempt_not_dispatched').length > 0,
    dispatch_started_recorded: eventsOfType(ofAttempt, 'dispatch_started').length > 0,
  });
  const dispatchState = impliesDispatch(outcome) && recordedDispatch === 'UNKNOWN' ? 'DISPATCHED' : recordedDispatch;
  const invocation = eventsOfType(callerEvents, 'caller_invocation_started').find(
    (event) => event.record.source_instance_id === registered.record.source_instance_id,
  );
  const head = {
    registered,
    ...(invocation === undefined ? {} : { invocation }),
    dispatch_state: dispatchState,
    ...(outcome === undefined ? {} : { outcome }),
  };
  if (outcome === undefined) {
    return { ...head, outcome_class: dispatchState === 'NOT_DISPATCHED' ? 'PRE_DISPATCH_FAILURE' : 'AMBIGUOUS' };
  }
  const classified = classifyOutcome(outcome.record.outcome, dispatchState);
  return classified.ok
    ? { ...head, outcome_class: classified.value }
    : { ...head, outcome_class: 'AMBIGUOUS', contradiction: classified.error };
}

// BR-RUA-021: every recorded outcome but FAILED was produced after the dispatch boundary.
function impliesDispatch(outcome: EventOf<'attempt_outcome_recorded'> | undefined): boolean {
  return outcome !== undefined && outcome.record.outcome !== 'FAILED';
}

/**
 * Orders events by `occurred_at`; equal instants keep their order (`toSorted` is stable).
 *
 * @example
 * events.toSorted(compareOccurrence);
 */
export function compareOccurrence(a: IndexedEvent, b: IndexedEvent): number {
  if (a.record.occurred_at === b.record.occurred_at) {
    return 0;
  }
  return a.record.occurred_at < b.record.occurred_at ? -1 : 1;
}
