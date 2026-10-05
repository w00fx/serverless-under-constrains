// AC-RUA-028: the dispatch boundary crossed or not locatable (BR-RUA-021). The attempt is
// DISPATCHED or UNKNOWN, and no absence observation may prove non-dispatch. Only the recorded
// conditional PRE_DISPATCH -> NOT_DISPATCHED transition proves NOT_DISPATCHED.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DispatchEvidence } from '../../../src/attempt-lifecycle/dispatch-classification.ts';
import { classifyDispatch } from '../../../src/attempt-lifecycle/dispatch-classification.ts';
import { foldEffectKnowledge } from '../../../src/attempt-lifecycle/effect-knowledge.ts';
import { classifyOutcome } from '../../../src/attempt-lifecycle/outcome-classification.ts';
import type { DispatchState } from '../../../src/record-contract/records/group-b/vocabulary.ts';

const EVIDENCE_VALUES: readonly (boolean | 'unknown')[] = [true, false, 'unknown'];

// The rule restated from BR-RUA-021, independently of the implementation's branch order:
// a recorded dispatch_started crosses the boundary; otherwise the recorded conditional
// NOT_DISPATCHED transition (of an attempt not proven unregistered) is the only proof of
// non-dispatch; everything else cannot be located.
function specDispatch(e: DispatchEvidence): DispatchState {
  const crossed = e.dispatch_started_recorded === true;
  const provenPreDispatch = e.not_dispatched_transition_recorded === true && e.pre_dispatch_registered !== false;
  if (crossed) {
    return 'DISPATCHED';
  }
  return provenPreDispatch ? 'NOT_DISPATCHED' : 'UNKNOWN';
}

describe('AC-RUA-028 dispatch boundary crossed or not locatable', () => {
  it('crash-after-dispatch-started: a recorded dispatch_started stays DISPATCHED', () => {
    // The caller crashed after the dispatch transition: no outcome, no provider call recorded.
    const evidence: DispatchEvidence = {
      pre_dispatch_registered: true,
      not_dispatched_transition_recorded: false,
      dispatch_started_recorded: true,
    };
    assert.equal(classifyDispatch(evidence), 'DISPATCHED');
    const outcome = classifyOutcome('FAILED', classifyDispatch(evidence));
    assert.deepEqual(outcome, { ok: true, value: 'AMBIGUOUS' });
    assert.equal(foldEffectKnowledge(['AMBIGUOUS']), 'UNKNOWN');
  });

  it('boundary-not-locatable: a gapped journal around the boundary gives UNKNOWN', () => {
    const evidence: DispatchEvidence = {
      pre_dispatch_registered: true,
      not_dispatched_transition_recorded: 'unknown',
      dispatch_started_recorded: 'unknown',
    };
    assert.equal(classifyDispatch(evidence), 'UNKNOWN');
    assert.deepEqual(classifyOutcome('FAILED', 'UNKNOWN'), { ok: true, value: 'AMBIGUOUS' });
  });

  it('absence-proves-nothing: no dispatch event, provider call or ledger effect is still UNKNOWN', () => {
    // A complete journal with neither dispatch_started nor the NOT_DISPATCHED transition, an
    // absent provider call and an absent ledger effect: DispatchEvidence has no field for the
    // latter two, so they cannot prove non-dispatch.
    const evidence: DispatchEvidence = {
      pre_dispatch_registered: true,
      not_dispatched_transition_recorded: false,
      dispatch_started_recorded: false,
    };
    assert.equal(classifyDispatch(evidence), 'UNKNOWN');
  });

  it('only the recorded conditional transition proves NOT_DISPATCHED', () => {
    assert.equal(
      classifyDispatch({
        pre_dispatch_registered: true,
        not_dispatched_transition_recorded: true,
        dispatch_started_recorded: false,
      }),
      'NOT_DISPATCHED',
    );
    assert.equal(
      classifyDispatch({
        pre_dispatch_registered: 'unknown',
        not_dispatched_transition_recorded: true,
        dispatch_started_recorded: 'unknown',
      }),
      'NOT_DISPATCHED',
    );
  });

  it('a NOT_DISPATCHED transition without a pre-dispatch registration proves nothing', () => {
    assert.equal(
      classifyDispatch({
        pre_dispatch_registered: false,
        not_dispatched_transition_recorded: true,
        dispatch_started_recorded: false,
      }),
      'UNKNOWN',
    );
  });

  it('a recorded dispatch_started wins over a recorded NOT_DISPATCHED transition', () => {
    assert.equal(
      classifyDispatch({
        pre_dispatch_registered: true,
        not_dispatched_transition_recorded: true,
        dispatch_started_recorded: true,
      }),
      'DISPATCHED',
    );
  });

  it('all 27 evidence combinations follow the BR-RUA-021 rule and never yield NOT_DISPATCHED from absence', () => {
    const combinations: readonly DispatchEvidence[] = EVIDENCE_VALUES.flatMap((registered) =>
      EVIDENCE_VALUES.flatMap((notDispatched) =>
        EVIDENCE_VALUES.map((started) => ({
          pre_dispatch_registered: registered,
          not_dispatched_transition_recorded: notDispatched,
          dispatch_started_recorded: started,
        })),
      ),
    );
    assert.equal(combinations.length, 27);
    let notDispatchedCount = 0;
    for (const evidence of combinations) {
      const state = classifyDispatch(evidence);
      assert.equal(state, specDispatch(evidence), JSON.stringify(evidence));
      notDispatchedCount += state === 'NOT_DISPATCHED' ? 1 : 0;
      assert.ok(state !== 'NOT_DISPATCHED' || evidence.not_dispatched_transition_recorded === true);
    }
    // registered in {true, unknown} x started in {false, unknown}
    assert.equal(notDispatchedCount, 4);
  });
});
