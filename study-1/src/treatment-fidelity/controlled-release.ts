// BR-RUA-014 controlled release (design §8.10, AC-RUA-032). The provider releases only after it
// observed the timeout: Ρ names Ω as its cause and follows it in the same provider source instance,
// and no `treatment_safety_released` exists. Any safety release leaves the condition indeterminate
// (AC-RUA-032 "a safety release"), as do missing events. A release without its observation in a
// complete provider journal, a release that does not name the observation, or a release sequenced
// before it fails the condition.

import { reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type { ConditionResult } from '../record-contract/records/group-c/shared-shapes.ts';
import { finishCondition, idOf, refOf } from './condition-result.ts';
import type { ConditionDraft } from './condition-result.ts';
import { causedBy } from './subject-events.ts';
import { incompleteArtifactReason } from './subject-artifacts.ts';
import type { TreatmentView } from './treatment-view.ts';

const CONDITION = 'BR-RUA-014';

const EXPECTED: JsonValue = {
  release_caused_by_observation: true,
  release_after_observation_in_same_instance: true,
  safety_release_count: 0,
};

/**
 * Judges BR-RUA-014 over the treatment view.
 *
 * @example
 * evaluateControlledRelease(view).result; // 'indeterminate' after any safety release
 */
export function evaluateControlledRelease(view: TreatmentView): ConditionResult {
  return finishCondition(CONDITION, draftOf(view), view.findings);
}

function draftOf(view: TreatmentView): ConditionDraft {
  const { release, observation } = view;
  const provider = view.journals.provider;
  const refs = [refOf(release), refOf(observation), ...view.safety_releases.map(refOf)];
  const draft = (result: ConditionDraft['result'], reasons: readonly StructuredReason[] = []): ConditionDraft => ({
    result,
    expected: EXPECTED,
    observed: observedOf(view),
    refs,
    reasons,
  });
  if (view.safety_releases.length > 0) {
    const detail = `${String(view.safety_releases.length)} treatment_safety_released event(s); expected none`;
    return draft('indeterminate', [reasonAt(CONDITION, 'SAFETY_RELEASED', detail, refOf(view.safety_releases[0]))]);
  }
  if (release === undefined) {
    return { ...draft('indeterminate', [releaseMissingReason(view)]), refs: [...refs, provider.ref] };
  }
  if (observation === undefined) {
    if (provider.complete) {
      return { ...draft('fail'), refs: [...refs, provider.ref] };
    }
    const detail = `release ${release.record.event_id} has no treatment_timeout_observed in an incomplete provider journal; expected the observation`;
    return draft('indeterminate', [reasonAt(CONDITION, 'EVENT_MISSING', detail, provider.ref)]);
  }
  if (!causedBy(release, observation)) {
    return draft('fail');
  }
  if (release.record.source_instance_id !== observation.record.source_instance_id) {
    const detail = `release instance ${release.record.source_instance_id} differs from observation instance ${observation.record.source_instance_id}; expected one provider instance to order them`;
    return draft('indeterminate', [reasonAt(CONDITION, 'SOURCE_INSTANCE_MISMATCH', detail, refOf(release))]);
  }
  return draft(release.record.source_sequence > observation.record.source_sequence ? 'pass' : 'fail');
}

function releaseMissingReason(view: TreatmentView): StructuredReason {
  const provider = view.journals.provider;
  if (provider.ref === undefined) {
    return incompleteArtifactReason(provider, CONDITION);
  }
  const detail = `no treatment_response_released for the targeted commit; expected the controlled release`;
  return reasonAt(CONDITION, 'EVENT_MISSING', detail, provider.ref);
}

function observedOf(view: TreatmentView): JsonValue {
  const release = view.release?.record;
  const observation = view.observation?.record;
  return {
    release_event_id: idOf(view.release),
    observation_event_id: idOf(view.observation),
    release_causation_event_ids: release?.causation_event_ids ?? null,
    release_source_sequence: release?.source_sequence ?? null,
    observation_source_sequence: observation?.source_sequence ?? null,
    same_source_instance:
      release === undefined || observation === undefined
        ? null
        : release.source_instance_id === observation.source_instance_id,
    safety_release_count: view.safety_releases.length,
  };
}
