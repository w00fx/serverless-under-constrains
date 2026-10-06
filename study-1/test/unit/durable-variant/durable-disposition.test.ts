// What a Durable step attempt decides after its provider attempt (BR-RUA-020, BR-RUA-024;
// AC-RUA-045 feed): a definitive answer finishes the request; any other outcome retries the step
// while a step attempt remains; at the last step attempt the inner execution is exhausted, which
// is request-level RETRIES_EXHAUSTED only at the source's last receive.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DURABLE_MAX_RECEIVE_COUNT,
  decideDurableExhaustion,
  decideDurableStep,
} from '../../../src/durable-variant/durable-disposition.ts';

const RUNNING = { processing_state: 'RUNNING', upstream_can_redeliver: true } as const;
const RETRIES_EXHAUSTED = { processing_state: 'FINISHED', terminal_reason: 'RETRIES_EXHAUSTED' } as const;

describe('decideDurableExhaustion', () => {
  it('uses the OR-RUA-002 redrive threshold of 2', () => {
    assert.equal(DURABLE_MAX_RECEIVE_COUNT, 2);
  });

  it('durable-exhausted-before-redelivery: an exhausted execution on the first receive keeps processing RUNNING', () => {
    assert.deepEqual(decideDurableExhaustion(1, 2), RUNNING);
  });

  it('is RETRIES_EXHAUSTED only when the exhausted execution ran on the last receive', () => {
    assert.deepEqual(decideDurableExhaustion(2, 2), RETRIES_EXHAUSTED);
  });

  it('reads a receive count above the maximum as the last receive', () => {
    assert.deepEqual(decideDurableExhaustion(3, 2), RETRIES_EXHAUSTED);
    assert.deepEqual(decideDurableExhaustion(Number.MAX_SAFE_INTEGER, 2), RETRIES_EXHAUSTED);
  });

  it('refuses a receive count that is not a positive safe integer', () => {
    for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      assert.throws(() => decideDurableExhaustion(count, 2), {
        name: 'RangeError',
        message: `receive_count ${String(count)}; expected a positive safe integer`,
      });
    }
  });
});

describe('decideDurableStep', () => {
  it('completes the step and finishes SUCCEEDED or PROVIDER_REJECTED on a definitive answer, at any step attempt', () => {
    for (const [stepAttempt, receiveCount] of [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ] as const) {
      assert.deepEqual(
        decideDurableStep({ outcome_class: 'SUCCESS', step_attempt: stepAttempt, receive_count: receiveCount }),
        { kind: 'complete', terminality: { processing_state: 'FINISHED', terminal_reason: 'SUCCEEDED' } },
      );
      assert.deepEqual(
        decideDurableStep({ outcome_class: 'REJECTION', step_attempt: stepAttempt, receive_count: receiveCount }),
        { kind: 'complete', terminality: { processing_state: 'FINISHED', terminal_reason: 'PROVIDER_REJECTED' } },
      );
    }
  });

  it('retries the step after a failed first step attempt, keeping processing RUNNING on either receive', () => {
    for (const cls of ['AMBIGUOUS', 'PRE_DISPATCH_FAILURE'] as const) {
      for (const receiveCount of [1, 2, 3]) {
        assert.deepEqual(decideDurableStep({ outcome_class: cls, step_attempt: 1, receive_count: receiveCount }), {
          kind: 'retry_step',
          failed_class: cls,
          terminality: RUNNING,
        });
      }
    }
  });

  it('exhausts the inner execution at the last step attempt: RUNNING on receive 1, RETRIES_EXHAUSTED on receive 2', () => {
    for (const cls of ['AMBIGUOUS', 'PRE_DISPATCH_FAILURE'] as const) {
      assert.deepEqual(decideDurableStep({ outcome_class: cls, step_attempt: 2, receive_count: 1 }), {
        kind: 'inner_exhausted',
        failed_class: cls,
        terminality: RUNNING,
      });
      assert.deepEqual(decideDurableStep({ outcome_class: cls, step_attempt: 2, receive_count: 2 }), {
        kind: 'inner_exhausted',
        failed_class: cls,
        terminality: RETRIES_EXHAUSTED,
      });
    }
  });

  it('reads an at-least-once re-run past the last step attempt as exhausted', () => {
    assert.deepEqual(decideDurableStep({ outcome_class: 'AMBIGUOUS', step_attempt: 3, receive_count: 2 }), {
      kind: 'inner_exhausted',
      failed_class: 'AMBIGUOUS',
      terminality: RETRIES_EXHAUSTED,
    });
  });

  it('refuses a step attempt or receive count that is not a positive safe integer', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      assert.throws(() => decideDurableStep({ outcome_class: 'SUCCESS', step_attempt: attempt, receive_count: 1 }), {
        name: 'RangeError',
        message: `step_attempt ${String(attempt)}; expected a positive safe integer`,
      });
    }
    assert.throws(() => decideDurableStep({ outcome_class: 'AMBIGUOUS', step_attempt: 1, receive_count: 0 }), {
      name: 'RangeError',
    });
    assert.throws(() => decideDurableStep({ outcome_class: 'AMBIGUOUS', step_attempt: 2, receive_count: 0 }), {
      name: 'RangeError',
    });
  });

  it('refuses an infinite or unsafe receive count instead of clamping it to the last receive (fuzz seed -1274475116)', () => {
    // Promoted counterexample ["PRE_DISPATCH_FAILURE", [1, Infinity]]: Math.min(Infinity, 2) is 2.
    for (const count of [Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      for (const [cls, stepAttempt] of [
        ['PRE_DISPATCH_FAILURE', 1],
        ['AMBIGUOUS', 2],
        ['SUCCESS', 1],
      ] as const) {
        assert.throws(
          () => decideDurableStep({ outcome_class: cls, step_attempt: stepAttempt, receive_count: count }),
          {
            name: 'RangeError',
            message: `receive_count ${String(count)}; expected a positive safe integer`,
          },
        );
      }
    }
  });
});
