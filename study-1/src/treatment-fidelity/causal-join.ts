// BR-RUA-013 causal join and observation (BR-RUA-025, design §8.10). The controller's signal Σ
// must be immediately caused by exactly the provider commit K and T's caller timeout Θ
// (`Σ.causation_event_ids == sort([K, Θ])`), reference T and Θ, and be observed by the provider:
// Ω names Σ as its cause. A recorded `timeout_signal_conflict_recorded`, a causation that lacks or
// adds a predecessor, a signal for another attempt's timeout, or an observation not caused by Σ
// fails the condition. A missing Σ, K, Θ or Ω leaves it indeterminate.

import { reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type { ConditionResult } from '../record-contract/records/group-c/shared-shapes.ts';
import { finishCondition, idOf, refOf } from './condition-result.ts';
import type { ConditionDraft } from './condition-result.ts';
import { causedBy } from './subject-events.ts';
import type { EventOf } from './subject-events.ts';
import { incompleteArtifactReason } from './subject-artifacts.ts';
import type { TreatmentView } from './treatment-view.ts';

const CONDITION = 'BR-RUA-013';

/**
 * Judges BR-RUA-013 over the treatment view.
 *
 * @example
 * evaluateCausalJoin(view).result; // 'fail' when the signal names only the caller timeout
 */
export function evaluateCausalJoin(view: TreatmentView): ConditionResult {
  return finishCondition(CONDITION, draftOf(view), view.findings);
}

function draftOf(view: TreatmentView): ConditionDraft {
  const { signal, commit, caller_timeout: timeout } = view;
  const refs = [refOf(signal), refOf(commit), refOf(timeout), refOf(view.observation), ...view.conflicts.map(refOf)];
  const draft = (result: ConditionDraft['result'], reasons: readonly StructuredReason[] = []): ConditionDraft => ({
    result,
    expected: expectedOf(view),
    observed: observedOf(view),
    refs,
    reasons,
  });
  if (view.conflicts.length > 0) {
    return draft('fail');
  }
  if (signal === undefined || commit === undefined || timeout === undefined) {
    return { ...draft('indeterminate', [missingReason(view)]), refs: [...refs, view.journals.controller.ref] };
  }
  if (!joinMatches(signal, commit, timeout)) {
    return draft('fail');
  }
  const observation = view.observation;
  if (observation === undefined) {
    const detail = `no treatment_timeout_observed for signal ${signal.record.event_id}; expected the provider to observe it`;
    return {
      ...draft('indeterminate', [reasonAt(CONDITION, 'EVENT_MISSING', detail, view.journals.provider.ref)]),
      refs: [...refs, view.journals.provider.ref],
    };
  }
  const observed = causedBy(observation, signal) && observation.record.signal_event_id === signal.record.event_id;
  return draft(observed ? 'pass' : 'fail');
}

function joinMatches(
  signal: EventOf<'timeout_signal_recorded'>,
  commit: EventOf<'provider_transaction_committed'>,
  timeout: EventOf<'caller_timeout_recorded'>,
): boolean {
  const expected = expectedCausation(commit, timeout);
  const actual = signal.record.causation_event_ids;
  return (
    actual.length === expected.length &&
    actual.every((id, index) => id === expected[index]) &&
    signal.record.attempt_id === timeout.record.attempt_id &&
    signal.record.caller_timeout_event_id === timeout.record.event_id &&
    signal.record.provider_commit_event_id === commit.record.event_id
  );
}

function expectedCausation(
  commit: EventOf<'provider_transaction_committed'>,
  timeout: EventOf<'caller_timeout_recorded'>,
): readonly string[] {
  return [commit.record.event_id, timeout.record.event_id].toSorted();
}

function missingReason(view: TreatmentView): StructuredReason {
  const controller = view.journals.controller;
  if (view.signal === undefined && controller.ref === undefined) {
    return incompleteArtifactReason(controller, CONDITION);
  }
  const missing = [
    view.signal === undefined ? 'timeout_signal_recorded' : undefined,
    view.commit === undefined ? 'the unique targeted provider_transaction_committed' : undefined,
    view.caller_timeout === undefined ? 'caller_timeout_recorded of the targeted attempt' : undefined,
  ].filter((name) => name !== undefined);
  const at = view.signal === undefined ? controller.ref : refOf(view.signal);
  return reasonAt(
    CONDITION,
    'EVENT_MISSING',
    `${missing.join(', ')} absent; expected the signal and both its causes`,
    at,
  );
}

function expectedOf(view: TreatmentView): JsonValue {
  const { commit, caller_timeout: timeout } = view;
  return {
    signal_causation_event_ids:
      commit === undefined || timeout === undefined ? null : expectedCausation(commit, timeout),
    signal_attempt_id: view.targeted_attempt_id ?? null,
    observation_caused_by_signal: true,
    conflict_count: 0,
  };
}

function observedOf(view: TreatmentView): JsonValue {
  const signal = view.signal?.record;
  return {
    signal_event_id: signal?.event_id ?? null,
    signal_causation_event_ids: signal?.causation_event_ids ?? null,
    signal_attempt_id: signal?.attempt_id ?? null,
    signal_caller_timeout_event_id: signal?.caller_timeout_event_id ?? null,
    signal_provider_commit_event_id: signal?.provider_commit_event_id ?? null,
    observation_event_id: idOf(view.observation),
    observation_causation_event_ids: view.observation?.record.causation_event_ids ?? null,
    conflict_count: view.conflicts.length,
  };
}
