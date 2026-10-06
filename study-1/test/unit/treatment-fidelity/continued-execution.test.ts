// BR-RUA-012 continued provider execution (design §8.10): Ω and Ρ exist and the chain Ρ→Ω→Σ→Θ
// resolves; a complete journal and a consistent snapshot of a waiting barrier prove the provider
// stopped; a safety release or missing events leave it indeterminate.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateContinuedExecution } from '../../../src/treatment-fidelity/continued-execution.ts';
import type { TreatmentView } from '../../../src/treatment-fidelity/treatment-view.ts';
import {
  documentOp,
  PROBE_IDS,
  probeEvidence,
  removeOp,
  SAFETY_RELEASE_PLAN,
  SUBJECT_FILES,
  treatmentView,
} from './support/treatment-evidence.ts';
import { PROBE_EDITS } from './support/treatment-scenarios.ts';
import { assertWellFormedCondition, codes, present } from './support/view-edits.ts';

/** The provider stopped at the barrier: neither Ω nor Ρ, and the item still TIMEOUT_SIGNALLED. */
const PROVIDER_STOPPED = [
  removeOp(SUBJECT_FILES.provider, 'treatment_response_released'),
  removeOp(SUBJECT_FILES.provider, 'treatment_timeout_observed'),
  documentOp(SUBJECT_FILES.snapshot, '/treatment/state', 'TIMEOUT_SIGNALLED'),
  documentOp(SUBJECT_FILES.snapshot, '/treatment/version', 3),
  { op: 'remove', path: SUBJECT_FILES.snapshot, pointer: '/treatment/observed_event_id' },
  { op: 'remove', path: SUBJECT_FILES.snapshot, pointer: '/treatment/release_event_id' },
] as const;

function judgedView(view: TreatmentView): ReturnType<typeof evaluateContinuedExecution> {
  const condition = evaluateContinuedExecution(view);
  assertWellFormedCondition(condition);
  return condition;
}

describe('BR-RUA-012 continued provider execution', () => {
  it('passes when the release, observation, signal and caller timeout chain resolves', () => {
    const condition = judgedView(treatmentView(probeEvidence()));
    assert.equal(condition.result, 'pass');
    assert.deepEqual(condition.observed, {
      release_event_id: PROBE_IDS.release_event,
      observation_event_id: PROBE_IDS.observation_event,
      signal_event_id: PROBE_IDS.signal_event,
      caller_timeout_event_id: PROBE_IDS.timeout_event,
      chain_resolves: true,
      safety_release_count: 0,
      treatment_state: 'RESPONSE_RELEASED',
    });
  });

  it('fails when the consistent snapshot shows the barrier still waiting', () => {
    const condition = judgedView(treatmentView(probeEvidence(PROVIDER_STOPPED)));
    assert.equal(condition.result, 'fail');
    assert.ok(condition.evidence_refs.some((ref) => ref.artifact_path === 'probe/state/treatment-state-snapshot.json'));
  });

  it('stays indeterminate when the waiting snapshot is not a consistent read', () => {
    const view = treatmentView(probeEvidence(PROVIDER_STOPPED));
    const snapshot = present(view.snapshot, 'snapshot');
    const inconsistent = { ...snapshot, record: { ...snapshot.record, consistent_read: false } };
    const condition = judgedView({ ...view, snapshot: inconsistent });
    assert.deepEqual(codes(condition.indeterminate_reasons), ['EVENT_MISSING']);
  });

  it('stays indeterminate when the barrier released, or the journal is incomplete', () => {
    const base = treatmentView(probeEvidence());
    const view = treatmentView(probeEvidence(PROVIDER_STOPPED));
    assert.equal(judgedView({ ...view, snapshot: present(base.snapshot, 'snapshot') }).result, 'indeterminate');
    const gapped = { ...view.journals.provider, complete: false };
    assert.equal(judgedView({ ...view, journals: { ...view.journals, provider: gapped } }).result, 'indeterminate');
    const { snapshot: _snapshot, ...withoutSnapshot } = view;
    const condition = judgedView(withoutSnapshot);
    assert.equal(condition.result, 'indeterminate');
    assert.equal((condition.observed as { treatment_state: null }).treatment_state, null);
  });

  it('stays indeterminate while one of Ω and Ρ exists without the other', () => {
    const view = treatmentView(probeEvidence(PROVIDER_STOPPED));
    const base = treatmentView(probeEvidence());
    assert.equal(
      judgedView({ ...view, observation: present(base.observation, 'observation') }).result,
      'indeterminate',
    );
    assert.equal(judgedView({ ...view, release: present(base.release, 'release') }).result, 'indeterminate');
  });

  it('is indeterminate with CAUSAL_CHAIN_UNRESOLVED when Ω is not caused by Σ', () => {
    const condition = judgedView(treatmentView(probeEvidence(PROBE_EDITS.observation_caused_by_commit)));
    assert.equal(condition.result, 'indeterminate');
    assert.deepEqual(codes(condition.indeterminate_reasons), ['CAUSAL_CHAIN_UNRESOLVED']);
    assert.equal(condition.indeterminate_reasons[0]?.event_id, PROBE_IDS.release_event);
  });

  it('is indeterminate with CAUSAL_CHAIN_UNRESOLVED when Ρ is not caused by Ω', () => {
    const condition = judgedView(treatmentView(probeEvidence(PROBE_EDITS.release_caused_by_signal)));
    assert.deepEqual(codes(condition.indeterminate_reasons), ['CAUSAL_CHAIN_UNRESOLVED']);
  });

  it('does not resolve the chain without Σ or Θ', () => {
    const view = treatmentView(probeEvidence());
    const { signal: _signal, ...withoutSignal } = view;
    const unsignalled = judgedView(withoutSignal);
    assert.deepEqual(codes(unsignalled.indeterminate_reasons), ['CAUSAL_CHAIN_UNRESOLVED']);
    assert.match(unsignalled.indeterminate_reasons[0]?.detail ?? '', /signal \(none\)/u);
    const { caller_timeout: _timeout, ...withoutTimeout } = view;
    assert.match(judgedView(withoutTimeout).indeterminate_reasons[0]?.detail ?? '', /caller timeout \(none\)/u);
  });

  it('is indeterminate with SAFETY_RELEASED after a safety release', () => {
    const condition = judgedView(treatmentView(probeEvidence([], SAFETY_RELEASE_PLAN)));
    assert.equal(condition.result, 'indeterminate');
    assert.deepEqual(codes(condition.indeterminate_reasons), ['SAFETY_RELEASED']);
    assert.equal((condition.observed as { safety_release_count: number }).safety_release_count, 1);
  });

  it('is indeterminate with EVENT_MISSING when Ρ is absent', () => {
    const condition = judgedView(treatmentView(probeEvidence(PROBE_EDITS.no_release)));
    assert.deepEqual(codes(condition.indeterminate_reasons), ['EVENT_MISSING']);
  });

  it('names the missing provider journal as ARTIFACT_MISSING', () => {
    const condition = judgedView(treatmentView(probeEvidence(PROBE_EDITS.no_provider_journal)));
    assert.ok(codes(condition.indeterminate_reasons).includes('ARTIFACT_MISSING'));
  });
});
