// BR-RUA-012 continued provider execution (design §8.10). The provider must keep executing after
// the caller aborts: Ω and Ρ exist for K and the chain Ρ→Ω→Σ→Θ resolves (the abort precedes Θ by
// BR-RUA-023, so a provider event caused through Θ acted after it). The provider stopped, which
// fails the condition, when its journal is complete, no Ω, Ρ or safety release exists, and a
// consistent treatment snapshot shows the barrier still waiting in COMMITTED_WAITING or
// TIMEOUT_SIGNALLED. A safety release or missing events leave it indeterminate.

import { reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type { ConditionResult } from '../record-contract/records/group-c/shared-shapes.ts';
import type { TreatmentState } from '../record-contract/records/group-b/vocabulary.ts';
import { finishCondition, idOf, refOf } from './condition-result.ts';
import type { ConditionDraft } from './condition-result.ts';
import { causedBy } from './subject-events.ts';
import type { EventOf } from './subject-events.ts';
import { incompleteArtifactReason } from './subject-artifacts.ts';
import type { TreatmentView } from './treatment-view.ts';

const CONDITION = 'BR-RUA-012';
/** A barrier still waiting for the signal or its observation: the provider stopped there. */
const STOPPED_STATES: ReadonlySet<TreatmentState> = new Set<TreatmentState>(['COMMITTED_WAITING', 'TIMEOUT_SIGNALLED']);

const EXPECTED: JsonValue = {
  timeout_observed: true,
  response_released: true,
  chain:
    'treatment_response_released -> treatment_timeout_observed -> timeout_signal_recorded -> caller_timeout_recorded',
};

/**
 * Judges BR-RUA-012 over the treatment view.
 *
 * @example
 * evaluateContinuedExecution(view).result; // 'fail' when the snapshot shows the barrier still waiting
 */
export function evaluateContinuedExecution(view: TreatmentView): ConditionResult {
  return finishCondition(CONDITION, draftOf(view), view.findings);
}

function draftOf(view: TreatmentView): ConditionDraft {
  const refs = [
    refOf(view.release),
    refOf(view.observation),
    refOf(view.signal),
    refOf(view.caller_timeout),
    ...view.safety_releases.map(refOf),
  ];
  const draft = (result: ConditionDraft['result'], reasons: readonly StructuredReason[] = []): ConditionDraft => ({
    result,
    expected: EXPECTED,
    observed: observedOf(view),
    refs,
    reasons,
  });
  const { observation, release } = view;
  if (observation !== undefined && release !== undefined) {
    return chainResolves(view) ? draft('pass') : draft('indeterminate', [chainReason(view, release, observation)]);
  }
  if (providerStopped(view)) {
    return { ...draft('fail'), refs: [...refs, view.journals.provider.ref, view.snapshot_state.ref] };
  }
  return { ...draft('indeterminate', missingReasons(view)), refs: [...refs, view.journals.provider.ref] };
}

function chainResolves(view: TreatmentView): boolean {
  const { release, observation, signal, caller_timeout: timeout } = view;
  return (
    release !== undefined &&
    observation !== undefined &&
    signal !== undefined &&
    timeout !== undefined &&
    causedBy(release, observation) &&
    causedBy(observation, signal) &&
    causedBy(signal, timeout)
  );
}

function chainReason(
  view: TreatmentView,
  release: EventOf<'treatment_response_released'>,
  observation: EventOf<'treatment_timeout_observed'>,
): StructuredReason {
  const detail = `the chain from release ${release.record.event_id} through observation ${observation.record.event_id}, signal ${idOf(view.signal) ?? '(none)'} and caller timeout ${idOf(view.caller_timeout) ?? '(none)'} does not resolve; expected each to name the next as its cause`;
  return reasonAt(CONDITION, 'CAUSAL_CHAIN_UNRESOLVED', detail, refOf(release));
}

function providerStopped(view: TreatmentView): boolean {
  const snapshot = view.snapshot?.record;
  return (
    view.observation === undefined &&
    view.release === undefined &&
    view.safety_releases.length === 0 &&
    view.journals.provider.complete &&
    snapshot?.consistent_read === true &&
    snapshot.item_present &&
    STOPPED_STATES.has(snapshot.treatment.state)
  );
}

function missingReasons(view: TreatmentView): readonly StructuredReason[] {
  const provider = view.journals.provider;
  if (provider.ref === undefined) {
    return [incompleteArtifactReason(provider, CONDITION)];
  }
  if (view.safety_releases.length > 0) {
    const detail = `${String(view.safety_releases.length)} treatment_safety_released event(s); expected the barrier released only by the observed signal`;
    return [reasonAt(CONDITION, 'SAFETY_RELEASED', detail, refOf(view.safety_releases[0]))];
  }
  const detail = `observation ${idOf(view.observation) ?? '(none)'} and release ${idOf(view.release) ?? '(none)'}, and no consistent snapshot of a waiting barrier; expected both events, or a complete journal and snapshot showing the provider stopped`;
  return [reasonAt(CONDITION, 'EVENT_MISSING', detail, provider.ref)];
}

function observedOf(view: TreatmentView): JsonValue {
  const snapshot = view.snapshot?.record;
  return {
    release_event_id: idOf(view.release),
    observation_event_id: idOf(view.observation),
    signal_event_id: idOf(view.signal),
    caller_timeout_event_id: idOf(view.caller_timeout),
    chain_resolves: chainResolves(view),
    safety_release_count: view.safety_releases.length,
    treatment_state: snapshot?.item_present === true ? snapshot.treatment.state : null,
  };
}
