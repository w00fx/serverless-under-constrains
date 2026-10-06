// BR-RUA-013 causal join and observation (BR-RUA-025, design §8.10): Σ is caused by exactly
// sort([K, Θ]), references T, Θ and K, and is observed by Ω; a recorded conflict fails it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateCausalJoin } from '../../../src/treatment-fidelity/causal-join.ts';
import type { TreatmentView } from '../../../src/treatment-fidelity/treatment-view.ts';
import { PROBE_IDS, probeEvidence, setOp, SUBJECT_FILES, treatmentView } from './support/treatment-evidence.ts';
import { PROBE_EDITS } from './support/treatment-scenarios.ts';
import { assertWellFormedCondition, codes, present, withRecord } from './support/view-edits.ts';

function judgedView(view: TreatmentView): ReturnType<typeof evaluateCausalJoin> {
  const condition = evaluateCausalJoin(view);
  assertWellFormedCondition(condition);
  return condition;
}

function judged(operations: Parameters<typeof probeEvidence>[0] = []): ReturnType<typeof evaluateCausalJoin> {
  return judgedView(treatmentView(probeEvidence(operations)));
}

describe('BR-RUA-013 causal join and observation', () => {
  it('passes when Σ joins K and Θ and Ω observes Σ', () => {
    const condition = judged();
    assert.equal(condition.result, 'pass');
    assert.deepEqual(condition.expected, {
      signal_causation_event_ids: [PROBE_IDS.timeout_event, PROBE_IDS.commit_event],
      signal_attempt_id: PROBE_IDS.attempt,
      observation_caused_by_signal: true,
      conflict_count: 0,
    });
    assert.deepEqual(condition.observed, {
      signal_event_id: PROBE_IDS.signal_event,
      signal_causation_event_ids: [PROBE_IDS.timeout_event, PROBE_IDS.commit_event],
      signal_attempt_id: PROBE_IDS.attempt,
      signal_caller_timeout_event_id: PROBE_IDS.timeout_event,
      signal_provider_commit_event_id: PROBE_IDS.commit_event,
      observation_event_id: PROBE_IDS.observation_event,
      observation_causation_event_ids: [PROBE_IDS.signal_event],
      conflict_count: 0,
    });
  });

  it('fails when Σ names only Θ as its cause', () => {
    const condition = judged([
      setOp(SUBJECT_FILES.controller, 'timeout_signal_recorded', '/causation_event_ids', [PROBE_IDS.timeout_event]),
    ]);
    assert.equal(condition.result, 'fail');
  });

  it('fails when Σ adds a predecessor beyond K and Θ', () => {
    const view = treatmentView(probeEvidence());
    const signal = withRecord(present(view.signal, 'signal'), {
      causation_event_ids: [PROBE_IDS.timeout_event, PROBE_IDS.commit_event, PROBE_IDS.dispatch_event],
    });
    assert.equal(judgedView({ ...view, signal }).result, 'fail');
  });

  it('fails when Σ names K and Θ in another order', () => {
    const view = treatmentView(probeEvidence());
    const signal = withRecord(present(view.signal, 'signal'), {
      causation_event_ids: [PROBE_IDS.commit_event, PROBE_IDS.timeout_event],
    });
    assert.equal(judgedView({ ...view, signal }).result, 'fail');
  });

  it('fails when Σ references another attempt', () => {
    assert.equal(judged(PROBE_EDITS.signal_other_attempt).result, 'fail');
  });

  it('fails when Σ references another caller timeout', () => {
    assert.equal(judged(PROBE_EDITS.signal_other_timeout).result, 'fail');
  });

  it('fails when Σ references another provider commit event', () => {
    assert.equal(judged(PROBE_EDITS.signal_other_commit).result, 'fail');
  });

  it('fails when Ω is not caused by Σ', () => {
    assert.equal(judged(PROBE_EDITS.observation_caused_by_commit).result, 'fail');
  });

  it('fails when Ω names another signal', () => {
    assert.equal(judged(PROBE_EDITS.observation_names_other_signal).result, 'fail');
  });

  it('fails on a recorded timeout-signal conflict and cites it', () => {
    const condition = judged(PROBE_EDITS.signal_conflict);
    assert.equal(condition.result, 'fail');
    assert.equal((condition.observed as { conflict_count: number }).conflict_count, 1);
    assert.ok(condition.evidence_refs.some((ref) => ref.event_id === '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'));
  });

  it('is indeterminate with EVENT_MISSING when Ω is absent', () => {
    const condition = judged(PROBE_EDITS.no_observation_dense);
    assert.equal(condition.result, 'indeterminate');
    assert.deepEqual(codes(condition.indeterminate_reasons), ['EVENT_MISSING']);
    assert.equal(condition.indeterminate_reasons[0]?.artifact_path, 'probe/journals/provider-journal.jsonl');
  });

  it('is indeterminate with EVENT_MISSING located at Σ when K is not unique', () => {
    const condition = judged(PROBE_EDITS.two_targeted_commits);
    assert.deepEqual(codes(condition.indeterminate_reasons), ['EVENT_MISSING']);
    assert.equal(condition.indeterminate_reasons[0]?.event_id, PROBE_IDS.signal_event);
    assert.equal((condition.expected as { signal_causation_event_ids: null }).signal_causation_event_ids, null);
  });

  it('is indeterminate with EVENT_MISSING when Σ is absent from a present controller journal', () => {
    const condition = judged(PROBE_EDITS.no_signal);
    assert.equal(condition.result, 'indeterminate');
    assert.match(condition.indeterminate_reasons[0]?.detail ?? '', /^timeout_signal_recorded absent/u);
  });

  it('names every missing event of the join', () => {
    const view = treatmentView(probeEvidence());
    const { signal: _s, commit: _k, caller_timeout: _t, targeted_attempt_id: _a, ...bare } = view;
    const condition = judgedView(bare);
    assert.match(
      condition.indeterminate_reasons[0]?.detail ?? '',
      /timeout_signal_recorded, the unique targeted provider_transaction_committed, caller_timeout_recorded/u,
    );
    assert.equal((condition.expected as { signal_attempt_id: null }).signal_attempt_id, null);
  });

  it('names the missing controller journal as ARTIFACT_MISSING', () => {
    const condition = judged(PROBE_EDITS.no_controller_journal);
    assert.ok(codes(condition.indeterminate_reasons).includes('ARTIFACT_MISSING'));
  });
});
