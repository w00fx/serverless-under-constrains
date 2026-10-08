// BR-RUA-015 no caller-observed success (design §8.10, D-26, AC-RUA-031): T's outcome is
// TIMED_OUT and no caller event of T carries K's transaction id; a late transport settlement is
// only reported.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateNoCallerSuccess } from '../../../src/treatment-fidelity/no-caller-success.ts';
import type { TreatmentView } from '../../../src/treatment-fidelity/treatment-view.ts';
import { PROBE_IDS, probeEvidence, treatmentView } from './support/treatment-evidence.ts';
import { PROBE_EDITS } from './support/treatment-scenarios.ts';
import { assertWellFormedCondition, codes, present, withRecord } from './support/view-edits.ts';

function judgedView(view: TreatmentView): ReturnType<typeof evaluateNoCallerSuccess> {
  const condition = evaluateNoCallerSuccess(view);
  assertWellFormedCondition(condition);
  return condition;
}

function judged(operations: Parameters<typeof probeEvidence>[0] = []): ReturnType<typeof evaluateNoCallerSuccess> {
  return judgedView(treatmentView(probeEvidence(operations)));
}

describe('BR-RUA-015 no caller-observed success', () => {
  it('passes on TIMED_OUT and reports the aborted late settlement', () => {
    const condition = judged();
    assert.equal(condition.result, 'pass');
    assert.deepEqual(condition.expected, {
      outcome: 'TIMED_OUT',
      caller_events_carrying_provider_transaction_id: [],
      provider_transaction_id: PROBE_IDS.transaction,
    });
    assert.deepEqual(condition.observed, {
      targeted_attempt_id: PROBE_IDS.attempt,
      outcome: 'TIMED_OUT',
      caller_events_carrying_provider_transaction_id: [],
      late_transport_settlements: ['aborted'],
    });
  });

  it('never fails on a late resolved settlement alone (its payload is never parsed)', () => {
    const view = treatmentView(probeEvidence());
    const resolved = withRecord(present(view.late_settlements[0], 'late settlement'), { settlement_kind: 'resolved' });
    const condition = judgedView({ ...view, late_settlements: [resolved] });
    assert.equal(condition.result, 'pass');
    assert.deepEqual((condition.observed as { late_transport_settlements: string[] }).late_transport_settlements, [
      'resolved',
    ]);
  });

  it('fails when T succeeded', () => {
    const condition = judged(PROBE_EDITS.outcome_succeeded);
    assert.equal(condition.result, 'fail');
    assert.deepEqual(
      (condition.observed as { caller_events_carrying_provider_transaction_id: string[] })
        .caller_events_carrying_provider_transaction_id,
      [PROBE_IDS.outcome_event],
    );
  });

  it("fails when a TIMED_OUT outcome still carries K's transaction id", () => {
    assert.equal(judged(PROBE_EDITS.timed_out_carrying_transaction).result, 'fail');
  });

  it('fails on SUCCEEDED even when K is not unique', () => {
    const view = treatmentView(probeEvidence(PROBE_EDITS.outcome_succeeded));
    const { commit: _commit, ...withoutCommit } = view;
    const condition = judgedView(withoutCommit);
    assert.equal(condition.result, 'fail');
    assert.equal((condition.expected as { provider_transaction_id: null }).provider_transaction_id, null);
  });

  it('is indeterminate with OUTCOME_NOT_TIMED_OUT when T was rejected', () => {
    const condition = judged(PROBE_EDITS.outcome_rejected);
    assert.equal(condition.result, 'indeterminate');
    assert.deepEqual(codes(condition.indeterminate_reasons), ['OUTCOME_NOT_TIMED_OUT']);
  });

  it('is indeterminate with EVENT_MISSING when T has no outcome', () => {
    const condition = judged(PROBE_EDITS.no_outcome);
    assert.deepEqual(codes(condition.indeterminate_reasons), ['EVENT_MISSING']);
  });

  it('names an unknown targeted attempt in its detail', () => {
    const view = treatmentView(probeEvidence(PROBE_EDITS.no_outcome));
    const { targeted_attempt_id: _attempt, ...unknown } = view;
    const condition = judgedView(unknown);
    assert.match(condition.indeterminate_reasons[0]?.detail ?? '', /targeted attempt \(unknown\)/u);
  });

  it('names the missing caller journal as ARTIFACT_MISSING', () => {
    const condition = judged(PROBE_EDITS.no_caller_journal);
    assert.deepEqual(codes(condition.indeterminate_reasons), ['ARTIFACT_MISSING']);
  });
});
