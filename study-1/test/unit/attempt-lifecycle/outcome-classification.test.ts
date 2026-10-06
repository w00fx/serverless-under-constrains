// BR-RUA-021 / BR-RUA-022 outcome classes for all 12 (outcome, dispatch state) pairs. Expected
// values come from the spec text: "SUCCEEDED, REJECTED, and TIMED_OUT imply DISPATCHED; FAILED
// may carry any dispatch state", and the four outcome classes of the BR-RUA-022 table. An
// UNKNOWN dispatch state is evidence that cannot tell, not evidence against dispatch, so only a
// proven NOT_DISPATCHED contradicts an outcome that implies DISPATCHED (BR-RUA-004 maps
// "TIMED_OUT -> UNKNOWN" whatever the dispatch state).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyOutcome,
  OUTCOME_CLASSES,
  OUTCOME_DISPATCH_CONTRADICTION,
} from '../../../src/attempt-lifecycle/outcome-classification.ts';
import type { AttemptOutcome, DispatchState } from '../../../src/record-contract/records/group-b/vocabulary.ts';

const CLASSIFIED: readonly (readonly [AttemptOutcome, DispatchState, string])[] = [
  ['SUCCEEDED', 'DISPATCHED', 'SUCCESS'],
  ['SUCCEEDED', 'UNKNOWN', 'SUCCESS'],
  ['REJECTED', 'DISPATCHED', 'REJECTION'],
  ['REJECTED', 'UNKNOWN', 'REJECTION'],
  ['TIMED_OUT', 'DISPATCHED', 'AMBIGUOUS'],
  ['TIMED_OUT', 'UNKNOWN', 'AMBIGUOUS'],
  ['FAILED', 'DISPATCHED', 'AMBIGUOUS'],
  ['FAILED', 'UNKNOWN', 'AMBIGUOUS'],
  ['FAILED', 'NOT_DISPATCHED', 'PRE_DISPATCH_FAILURE'],
];

const CONTRADICTIONS: readonly AttemptOutcome[] = ['SUCCEEDED', 'REJECTED', 'TIMED_OUT'];

describe('classifyOutcome', () => {
  for (const [outcome, dispatch, expected] of CLASSIFIED) {
    it(`${outcome}/${dispatch} is ${expected}`, () => {
      assert.deepEqual(classifyOutcome(outcome, dispatch), { ok: true, value: expected });
    });
  }

  for (const outcome of CONTRADICTIONS) {
    it(`${outcome}/NOT_DISPATCHED contradicts BR-RUA-021`, () => {
      assert.deepEqual(classifyOutcome(outcome, 'NOT_DISPATCHED'), {
        ok: false,
        error: {
          code: OUTCOME_DISPATCH_CONTRADICTION,
          subject: 'BR-RUA-021',
          detail: `outcome ${outcome} with dispatch state NOT_DISPATCHED; expected DISPATCHED or UNKNOWN, because SUCCEEDED, REJECTED and TIMED_OUT imply DISPATCHED`,
        },
      });
    });
  }

  it('covers all 12 (outcome, dispatch state) pairs exactly once', () => {
    const pairs = [...CLASSIFIED.map(([o, d]) => `${o}/${d}`), ...CONTRADICTIONS.map((o) => `${o}/NOT_DISPATCHED`)];
    assert.equal(new Set(pairs).size, 12);
  });

  it('names the four BR-RUA-022 columns in table order', () => {
    assert.deepEqual(OUTCOME_CLASSES, ['PRE_DISPATCH_FAILURE', 'REJECTION', 'SUCCESS', 'AMBIGUOUS']);
    assert.equal(OUTCOME_DISPATCH_CONTRADICTION, 'OUTCOME_DISPATCH_CONTRADICTION');
  });
});
