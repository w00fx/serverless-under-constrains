// BR-RUA-011 application timeout (BR-RUA-023, design §8.10, A-12): Θ durably present with at least
// 3 s elapsed, the timer as winner, transport unsettled at the claim, the abort no later than the
// record, the dispatch as cause and origin, and T's outcome TIMED_OUT.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  APPLICATION_DEADLINE_NS,
  evaluateApplicationTimeout,
} from '../../../src/treatment-fidelity/application-timeout.ts';
import type { TreatmentView } from '../../../src/treatment-fidelity/treatment-view.ts';
import { PROBE_IDS, probeEvidence, setOp, SUBJECT_FILES, treatmentView } from './support/treatment-evidence.ts';
import { PROBE_EDITS } from './support/treatment-scenarios.ts';
import { assertWellFormedCondition, codes, present, withRecord } from './support/view-edits.ts';

function judgedView(view: TreatmentView): ReturnType<typeof evaluateApplicationTimeout> {
  const condition = evaluateApplicationTimeout(view);
  assertWellFormedCondition(condition);
  return condition;
}

function judged(operations: Parameters<typeof probeEvidence>[0] = []): ReturnType<typeof evaluateApplicationTimeout> {
  return judgedView(treatmentView(probeEvidence(operations)));
}

describe('BR-RUA-011 application timeout', () => {
  it('declares the three-second deadline in nanoseconds', () => {
    assert.equal(APPLICATION_DEADLINE_NS, '3000000000');
  });

  it('passes for the base probe and reports the timer facts it judged', () => {
    const condition = judged();
    assert.equal(condition.result, 'pass');
    assert.deepEqual(condition.observed, {
      caller_timeout_event_id: PROBE_IDS.timeout_event,
      elapsed_ns: '3000400000',
      arbiter_winner: 'TIMER',
      transport_settled_at_claim: false,
      abort_requested_at: '2026-10-05T12:05:08.041Z',
      recorded_at: '2026-10-05T12:05:08.042Z',
      causation_event_ids: [PROBE_IDS.dispatch_event],
      monotonic_origin_event_id: PROBE_IDS.dispatch_event,
      dispatch_event_id: PROBE_IDS.dispatch_event,
      outcome: 'TIMED_OUT',
    });
  });

  it('fails when the transport won the arbiter', () => {
    assert.equal(
      judged([setOp(SUBJECT_FILES.caller, 'caller_timeout_recorded', '/arbiter_winner', 'TRANSPORT')]).result,
      'fail',
    );
  });

  it('fails when transport had settled at the claim', () => {
    const condition = judged([
      setOp(SUBJECT_FILES.caller, 'caller_timeout_recorded', '/transport_settled_at_claim', true),
    ]);
    assert.equal(condition.result, 'fail');
  });

  it('fails when less than three seconds elapsed', () => {
    assert.equal(judged(PROBE_EDITS.elapsed_short).result, 'fail');
  });

  it('fails when the abort was requested after the record', () => {
    assert.equal(judged(PROBE_EDITS.abort_after_record).result, 'fail');
  });

  it('fails when elapsed_ns is not a decimal string (A-05)', () => {
    const view = treatmentView(probeEvidence());
    const timeout = withRecord(present(view.caller_timeout, 'caller timeout'), { elapsed_ns: 'three seconds' });
    assert.equal(judgedView({ ...view, caller_timeout: timeout }).result, 'fail');
  });

  it('is indeterminate with TIMEOUT_NOT_CORRELATED when the origin is not the dispatch', () => {
    const condition = judged(PROBE_EDITS.origin_not_dispatch);
    assert.equal(condition.result, 'indeterminate');
    assert.deepEqual(codes(condition.indeterminate_reasons), ['TIMEOUT_NOT_CORRELATED']);
    assert.equal(condition.indeterminate_reasons[0]?.event_id, PROBE_IDS.timeout_event);
  });

  it('is indeterminate with TIMEOUT_NOT_CORRELATED when the dispatch is not the cause', () => {
    const view = treatmentView(probeEvidence());
    const timeout = withRecord(present(view.caller_timeout, 'caller timeout'), {
      causation_event_ids: [PROBE_IDS.invocation_event],
    });
    const condition = judgedView({ ...view, caller_timeout: timeout });
    assert.deepEqual(codes(condition.indeterminate_reasons), ['TIMEOUT_NOT_CORRELATED']);
  });

  it('is indeterminate with EVENT_MISSING when the dispatch is absent', () => {
    const view = treatmentView(probeEvidence());
    const { dispatch: _dispatch, ...withoutDispatch } = view;
    const condition = judgedView(withoutDispatch);
    assert.equal(condition.result, 'indeterminate');
    assert.deepEqual(codes(condition.indeterminate_reasons), ['EVENT_MISSING']);
    assert.equal((condition.observed as { dispatch_event_id: null }).dispatch_event_id, null);
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

  it('fails without Θ when a complete caller journal shows a non-timeout outcome', () => {
    const view = treatmentView(probeEvidence(PROBE_EDITS.outcome_rejected));
    const { caller_timeout: _timeout, ...withoutTimeout } = view;
    const condition = judgedView(withoutTimeout);
    assert.equal(condition.result, 'fail');
    assert.equal((condition.observed as { caller_timeout_event_id: null }).caller_timeout_event_id, null);
  });

  it('stays indeterminate without Θ when the outcome is TIMED_OUT or the journal is incomplete', () => {
    const view = treatmentView(probeEvidence());
    const { caller_timeout: _timeout, ...withoutTimeout } = view;
    assert.deepEqual(codes(judgedView(withoutTimeout).indeterminate_reasons), ['EVENT_MISSING']);
    const rejected = treatmentView(probeEvidence(PROBE_EDITS.outcome_rejected));
    const { caller_timeout: _rejectedTimeout, ...rejectedWithoutTimeout } = rejected;
    const gapped = { ...rejected.journals.caller, complete: false };
    const condition = judgedView({ ...rejectedWithoutTimeout, journals: { ...rejected.journals, caller: gapped } });
    assert.equal(condition.result, 'indeterminate');
  });

  it('is indeterminate with EVENT_MISSING when Θ is absent from a present journal', () => {
    const condition = judged(PROBE_EDITS.no_caller_timeout);
    assert.equal(condition.result, 'indeterminate');
    assert.ok(codes(condition.indeterminate_reasons).includes('EVENT_MISSING'));
  });

  it('names the missing caller journal as ARTIFACT_MISSING', () => {
    const condition = judged(PROBE_EDITS.no_caller_journal);
    assert.deepEqual(codes(condition.indeterminate_reasons), ['ARTIFACT_MISSING']);
  });

  it('names an unknown targeted attempt in its detail', () => {
    const view = treatmentView(probeEvidence(PROBE_EDITS.no_caller_timeout));
    const { targeted_attempt_id: _attempt, ...unknown } = view;
    const condition = evaluateApplicationTimeout(unknown);
    assert.match(condition.indeterminate_reasons[0]?.detail ?? '', /\(unknown\)/u);
  });
});
