// BR-RUA-021 / BR-RUA-022 outcome classes for all 12 (outcome, dispatch state) pairs. Expected
// values come from the spec text: "SUCCEEDED, REJECTED, and TIMED_OUT imply DISPATCHED; FAILED
// may carry any dispatch state", and the four outcome classes of the BR-RUA-022 table.

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
  ['REJECTED', 'DISPATCHED', 'REJECTION'],
  ['TIMED_OUT', 'DISPATCHED', 'AMBIGUOUS'],
  ['FAILED', 'DISPATCHED', 'AMBIGUOUS'],
  ['FAILED', 'UNKNOWN', 'AMBIGUOUS'],
  ['FAILED', 'NOT_DISPATCHED', 'PRE_DISPATCH_FAILURE'],
];

const CONTRADICTIONS: readonly (readonly [AttemptOutcome, DispatchState])[] = [
  ['SUCCEEDED', 'NOT_DISPATCHED'],
  ['SUCCEEDED', 'UNKNOWN'],
  ['REJECTED', 'NOT_DISPATCHED'],
  ['REJECTED', 'UNKNOWN'],
  ['TIMED_OUT', 'NOT_DISPATCHED'],
  ['TIMED_OUT', 'UNKNOWN'],
];

describe('classifyOutcome', () => {
  for (const [outcome, dispatch, expected] of CLASSIFIED) {
    it(`${outcome}/${dispatch} is ${expected}`, () => {
      assert.deepEqual(classifyOutcome(outcome, dispatch), { ok: true, value: expected });
    });
  }

  for (const [outcome, dispatch] of CONTRADICTIONS) {
    it(`${outcome}/${dispatch} contradicts BR-RUA-021`, () => {
      assert.deepEqual(classifyOutcome(outcome, dispatch), {
        ok: false,
        error: {
          code: OUTCOME_DISPATCH_CONTRADICTION,
          subject: 'BR-RUA-021',
          detail: `outcome ${outcome} with dispatch state ${dispatch}; expected dispatch state DISPATCHED, because SUCCEEDED, REJECTED and TIMED_OUT imply DISPATCHED`,
        },
      });
    });
  }

  it('names the four BR-RUA-022 columns in table order', () => {
    assert.deepEqual(OUTCOME_CLASSES, ['PRE_DISPATCH_FAILURE', 'REJECTION', 'SUCCESS', 'AMBIGUOUS']);
    assert.equal(OUTCOME_DISPATCH_CONTRADICTION, 'OUTCOME_DISPATCH_CONTRADICTION');
  });
});
