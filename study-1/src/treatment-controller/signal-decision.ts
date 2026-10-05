// The controller decision table (design §9.11, BR-RUA-025), as one pure function. "Match" means
// the caller event's `attempt_id` equals the treatment's targeted attempt. Each decision carries
// exactly the identities its journal record needs, so the controller only writes.
//
// Ordering inside an experiment partition: an event that fails validation is INVALID_EVENT
// whatever the treatment; a CONTROL configuration is CONTROL_TRIAL (no treatment exists to
// signal, AC-RUA-029); a COMMIT_THEN_TIMEOUT partition without a treatment item cannot be judged
// and is INVALID_EVENT. SAFETY_RELEASED always yields `late_rejected`, including for the event
// that would once have been a duplicate, because a released barrier has no signal to repeat and
// the duplicate record admits only the signalled states.

import type { ExecutionIdentity, JsonValue, Uuid4 } from '../record-contract/primitives.ts';
import type { SignalledTreatmentState, TreatmentState } from '../record-contract/records/group-b/vocabulary.ts';
import type { CallerTimeoutView, InvalidCallerTimeout } from './caller-timeout-event.ts';
import { canaryExpectation, experimentExpectation, readCallerTimeout } from './caller-timeout-event.ts';
import type { ControllerConfigView, ControllerTreatment } from './controller-control-items.ts';

/** The caller event a decision answers. */
export interface CallerEventRefs {
  readonly caller_timeout_event_id: Uuid4;
  readonly attempt_id: Uuid4;
}

export type SignalDecision =
  | ({
      readonly kind: 'signal';
      /** Sorted `[provider commit event, caller timeout event]`. */
      readonly causation: readonly [Uuid4, Uuid4];
      readonly provider_commit_id: Uuid4;
      readonly commit_event_id: Uuid4;
    } & CallerEventRefs)
  | ({ readonly kind: 'duplicate_ignored'; readonly treatment_state: SignalledTreatmentState } & CallerEventRefs)
  | ({
      readonly kind: 'conflict';
      readonly existing_caller_event_id: Uuid4;
      readonly treatment_state: SignalledTreatmentState;
    } & CallerEventRefs)
  | ({ readonly kind: 'late_rejected' } & CallerEventRefs)
  | ({ readonly kind: 'before_commit_rejected'; readonly detail: string } & CallerEventRefs)
  | ({ readonly kind: 'not_targeted_rejected'; readonly detail: string } & CallerEventRefs)
  | ({ readonly kind: 'control_trial_rejected'; readonly detail: string } & CallerEventRefs)
  | ({ readonly kind: 'invalid_event_rejected'; readonly treatment_state?: TreatmentState } & InvalidCallerTimeout)
  | { readonly kind: 'canary_acknowledged'; readonly canary_event_id: Uuid4 };

/** Where the event was inserted and what the controller knows about that partition. */
export type SignalContext =
  | { readonly kind: 'canary'; readonly deployment: ExecutionIdentity }
  | {
      readonly kind: 'experiment';
      readonly deployment: ExecutionIdentity;
      readonly configuration: ControllerConfigView;
    };

/**
 * Decides what one inserted caller event means for treatment (design §9.11).
 *
 * @example
 * decideSignal(image, { kind: 'experiment', deployment, configuration }, { state: 'COMMITTED_WAITING', ... });
 * // { kind: 'signal', causation: [commitEventId, callerEventId] (sorted), ... }
 */
export function decideSignal(
  event: JsonValue,
  context: SignalContext,
  treatment: ControllerTreatment | undefined,
): SignalDecision {
  if (context.kind === 'canary') {
    const canary = readCallerTimeout(event, canaryExpectation(context.deployment));
    return canary.ok
      ? { kind: 'canary_acknowledged', canary_event_id: canary.value.event_id }
      : { kind: 'invalid_event_rejected', ...canary.error };
  }
  const read = readCallerTimeout(event, experimentExpectation(context.deployment, context.configuration));
  if (!read.ok) {
    return {
      kind: 'invalid_event_rejected',
      ...read.error,
      ...(treatment === undefined ? {} : { treatment_state: treatment.state }),
    };
  }
  const refs = callerRefs(read.value);
  if (context.configuration.scenario === 'CONTROL') {
    return { kind: 'control_trial_rejected', ...refs, detail: 'scenario CONTROL arms no treatment; nothing to signal' };
  }
  if (treatment === undefined) {
    return {
      kind: 'invalid_event_rejected',
      ...refs,
      detail: 'no treatment item in a COMMIT_THEN_TIMEOUT partition; expected one armed before publication',
    };
  }
  return decideOnTreatment(refs, treatment);
}

function decideOnTreatment(refs: CallerEventRefs, treatment: ControllerTreatment): SignalDecision {
  switch (treatment.state) {
    case 'ARMED':
      return {
        kind: 'before_commit_rejected',
        ...refs,
        detail: 'treatment ARMED; the targeted commit has not happened',
      };
    case 'SAFETY_RELEASED':
      return { kind: 'late_rejected', ...refs };
    case 'COMMITTED_WAITING':
      return decideCommittedWait(refs, treatment);
    case 'TIMEOUT_SIGNALLED':
    case 'TIMEOUT_OBSERVED':
    case 'RESPONSE_RELEASED':
      return decideSignalled(refs, treatment);
  }
}

function decideCommittedWait(
  refs: CallerEventRefs,
  treatment: Extract<ControllerTreatment, { readonly state: 'COMMITTED_WAITING' }>,
): SignalDecision {
  if (refs.attempt_id !== treatment.targeted_attempt_id) {
    return {
      kind: 'not_targeted_rejected',
      ...refs,
      detail: `attempt_id ${refs.attempt_id}; expected the targeted attempt ${treatment.targeted_attempt_id}`,
    };
  }
  return {
    kind: 'signal',
    ...refs,
    causation: sortedPair(treatment.commit_event_id, refs.caller_timeout_event_id),
    provider_commit_id: treatment.provider_commit_id,
    commit_event_id: treatment.commit_event_id,
  };
}

function decideSignalled(
  refs: CallerEventRefs,
  treatment: Extract<ControllerTreatment, { readonly signal_caller_event_id: Uuid4 }>,
): SignalDecision {
  if (treatment.signal_caller_event_id === refs.caller_timeout_event_id) {
    return { kind: 'duplicate_ignored', ...refs, treatment_state: treatment.state };
  }
  return {
    kind: 'conflict',
    ...refs,
    existing_caller_event_id: treatment.signal_caller_event_id,
    treatment_state: treatment.state,
  };
}

function callerRefs(view: CallerTimeoutView): CallerEventRefs {
  return { caller_timeout_event_id: view.event_id, attempt_id: view.attempt_id };
}

function sortedPair(a: Uuid4, b: Uuid4): readonly [Uuid4, Uuid4] {
  return a <= b ? [a, b] : [b, a];
}
