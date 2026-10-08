// BR-RUA-014 controlled release (design §8.10, AC-RUA-032): Ρ is caused by Ω and follows it in
// the same provider instance, with no safety release.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateControlledRelease } from '../../../src/treatment-fidelity/controlled-release.ts';
import type { TreatmentView } from '../../../src/treatment-fidelity/treatment-view.ts';
import {
  PROBE_IDS,
  probeEvidence,
  SAFETY_RELEASE_PLAN,
  setOp,
  SUBJECT_FILES,
  treatmentView,
} from './support/treatment-evidence.ts';
import { PROBE_EDITS } from './support/treatment-scenarios.ts';
import { assertWellFormedCondition, codes, present, withRecord } from './support/view-edits.ts';

function judgedView(view: TreatmentView): ReturnType<typeof evaluateControlledRelease> {
  const condition = evaluateControlledRelease(view);
  assertWellFormedCondition(condition);
  return condition;
}

function judged(operations: Parameters<typeof probeEvidence>[0] = []): ReturnType<typeof evaluateControlledRelease> {
  return judgedView(treatmentView(probeEvidence(operations)));
}

describe('BR-RUA-014 controlled release', () => {
  it('passes when Ρ follows the Ω it names in one provider instance', () => {
    const condition = judged();
    assert.equal(condition.result, 'pass');
    assert.deepEqual(condition.observed, {
      release_event_id: PROBE_IDS.release_event,
      observation_event_id: PROBE_IDS.observation_event,
      release_causation_event_ids: [PROBE_IDS.observation_event],
      release_source_sequence: 6,
      observation_source_sequence: 5,
      same_source_instance: true,
      safety_release_count: 0,
    });
  });

  it('fails when Ρ is sequenced before Ω', () => {
    const condition = judged([
      setOp(SUBJECT_FILES.provider, 'treatment_timeout_observed', '/source_sequence', 6),
      setOp(SUBJECT_FILES.provider, 'treatment_response_released', '/source_sequence', 5),
    ]);
    assert.equal(condition.result, 'fail');
  });

  it('fails when Ρ and Ω share a sequence number', () => {
    const view = treatmentView(probeEvidence());
    const release = withRecord(present(view.release, 'release'), { source_sequence: 5 });
    assert.equal(judgedView({ ...view, release }).result, 'fail');
  });

  it('fails when Ρ does not name Ω as its cause', () => {
    assert.equal(judged(PROBE_EDITS.release_caused_by_signal).result, 'fail');
  });

  it('fails when Ρ exists without Ω in a complete provider journal', () => {
    const condition = judged(PROBE_EDITS.no_observation_dense);
    assert.equal(condition.result, 'fail');
    assert.equal((condition.observed as { same_source_instance: null }).same_source_instance, null);
  });

  it('is indeterminate with EVENT_MISSING when Ω is absent from an incomplete journal', () => {
    const condition = judged(PROBE_EDITS.no_observation_gapped);
    assert.equal(condition.result, 'indeterminate');
    assert.ok(codes(condition.indeterminate_reasons).includes('EVENT_MISSING'));
  });

  it('is indeterminate with SOURCE_INSTANCE_MISMATCH when another instance wrote Ρ', () => {
    const condition = judged(PROBE_EDITS.release_other_instance);
    assert.equal(condition.result, 'indeterminate');
    assert.deepEqual(codes(condition.indeterminate_reasons), ['SOURCE_INSTANCE_MISMATCH']);
    assert.equal((condition.observed as { same_source_instance: boolean }).same_source_instance, false);
  });

  it('is indeterminate with SAFETY_RELEASED after any safety release', () => {
    const released = judgedView(treatmentView(probeEvidence([], SAFETY_RELEASE_PLAN)));
    assert.equal(released.result, 'indeterminate');
    assert.deepEqual(codes(released.indeterminate_reasons), ['SAFETY_RELEASED']);
    assert.equal((released.observed as { safety_release_count: number }).safety_release_count, 1);
  });

  it('is indeterminate with EVENT_MISSING when Ρ is absent', () => {
    const condition = judged(PROBE_EDITS.no_release);
    assert.deepEqual(codes(condition.indeterminate_reasons), ['EVENT_MISSING']);
  });

  it('names the missing provider journal as ARTIFACT_MISSING', () => {
    const condition = judged(PROBE_EDITS.no_provider_journal);
    assert.deepEqual(codes(condition.indeterminate_reasons), ['ARTIFACT_MISSING']);
  });
});
