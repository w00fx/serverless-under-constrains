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

type Evidence = boolean | 'unknown';
const T = true;
const F = false;
const U = 'unknown';
const D = 'DISPATCHED';
const N = 'NOT_DISPATCHED';
const X = 'UNKNOWN';

// The 27 evidence combinations, written out from the BR-RUA-021 text rather than derived from
// the implementation. Columns: pre-dispatch registration, recorded NOT_DISPATCHED transition,
// recorded dispatch_started, expected state.
// - "Immediately before invoking transport, the caller records dispatch_started and sets
//   DISPATCHED. A crash after that boundary remains conservatively dispatched": every row with
//   dispatch_started recorded (T) is DISPATCHED.
// - "NOT_DISPATCHED requires a conditional durable transition proving the attempt failed
//   before provider-client dispatch began": NOT_DISPATCHED needs the transition recorded (T).
//   The transition is conditional on the durable pre-dispatch state ("Every physical attempt
//   begins in a durable pre-dispatch state"), so evidence that the registration is absent (F)
//   makes the transition unprovable; an unknown registration (U) does not contradict it.
// - "Absence of a dispatch event ... does not prove NOT_DISPATCHED": every other row is UNKNOWN.
const EXPECTED: readonly (readonly [Evidence, Evidence, Evidence, DispatchState])[] = [
  [T, T, T, D],
  [T, T, F, N],
  [T, T, U, N],
  [T, F, T, D],
  [T, F, F, X],
  [T, F, U, X],
  [T, U, T, D],
  [T, U, F, X],
  [T, U, U, X],
  [F, T, T, D],
  [F, T, F, X],
  [F, T, U, X],
  [F, F, T, D],
  [F, F, F, X],
  [F, F, U, X],
  [F, U, T, D],
  [F, U, F, X],
  [F, U, U, X],
  [U, T, T, D],
  [U, T, F, N],
  [U, T, U, N],
  [U, F, T, D],
  [U, F, F, X],
  [U, F, U, X],
  [U, U, T, D],
  [U, U, F, X],
  [U, U, U, X],
];

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

  it('all 27 evidence combinations match the table written from BR-RUA-021', () => {
    assert.equal(new Set(EXPECTED.map(([r, n, d]) => `${String(r)}/${String(n)}/${String(d)}`)).size, 27);
    for (const [registered, notDispatched, started, expected] of EXPECTED) {
      const evidence: DispatchEvidence = {
        pre_dispatch_registered: registered,
        not_dispatched_transition_recorded: notDispatched,
        dispatch_started_recorded: started,
      };
      assert.equal(classifyDispatch(evidence), expected, JSON.stringify(evidence));
    }
  });

  it('spec invariants: NOT_DISPATCHED only with the recorded transition; dispatch_started always DISPATCHED', () => {
    for (const [registered, notDispatched, started] of EXPECTED) {
      const state = classifyDispatch({
        pre_dispatch_registered: registered,
        not_dispatched_transition_recorded: notDispatched,
        dispatch_started_recorded: started,
      });
      assert.ok(state !== 'NOT_DISPATCHED' || notDispatched === true);
      assert.ok(started !== true || state === 'DISPATCHED');
    }
  });
});
