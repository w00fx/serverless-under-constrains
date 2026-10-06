// Property-based tests of the Durable step disposition (BR-RUA-020, BR-RUA-024; AC-RUA-045 feed):
// over every outcome class, step attempt and receive count, a definitive answer completes the
// step; any other outcome fails it, retrying on the first step attempt and exhausting the inner
// execution from the second; and the request finishes RETRIES_EXHAUSTED only when the inner
// execution is exhausted on the source's last receive, so it never finishes while SQS can still
// redeliver it (design §8.7).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { OUTCOME_CLASSES } from '../../../src/attempt-lifecycle/outcome-classification.ts';
import { DURABLE_MAX_RECEIVE_COUNT, decideDurableStep } from '../../../src/durable-variant/durable-disposition.ts';
import { DURABLE_STEP_ATTEMPTS } from '../../../src/durable-variant/durable-retry.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const positive = fc.oneof(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }));
const notPositive = fc.oneof(
  fc.integer({ min: Number.MIN_SAFE_INTEGER, max: 0 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 2),
);

describe('decideDurableStep properties', () => {
  it('completes the definitive answers, retries then exhausts the others, and exhausts the request only at the last receive', () => {
    fc.assert(
      fc.property(fc.constantFrom(...OUTCOME_CLASSES), positive, positive, (cls, stepAttempt, receiveCount) => {
        const decision = decideDurableStep({
          outcome_class: cls,
          step_attempt: stepAttempt,
          receive_count: receiveCount,
        });
        if (cls === 'SUCCESS' || cls === 'REJECTION') {
          assert.equal(decision.kind, 'complete');
          assert.equal(decision.terminality.processing_state, 'FINISHED');
          return;
        }
        assert.ok(decision.kind !== 'complete');
        assert.equal(decision.failed_class, cls);
        const exhausted = stepAttempt >= DURABLE_STEP_ATTEMPTS;
        assert.equal(decision.kind, exhausted ? 'inner_exhausted' : 'retry_step');
        const requestExhausted = exhausted && receiveCount >= DURABLE_MAX_RECEIVE_COUNT;
        assert.deepEqual(
          decision.terminality,
          requestExhausted
            ? { processing_state: 'FINISHED', terminal_reason: 'RETRIES_EXHAUSTED' }
            : { processing_state: 'RUNNING', upstream_can_redeliver: true },
        );
      }),
      fuzzParameters(),
    );
  });

  it('refuses a step attempt or receive count that is not a positive safe integer with a RangeError', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...OUTCOME_CLASSES.filter((cls) => cls === 'AMBIGUOUS' || cls === 'PRE_DISPATCH_FAILURE')),
        fc.oneof(
          fc.tuple(notPositive, positive),
          fc.tuple(fc.constant(DURABLE_STEP_ATTEMPTS), notPositive),
          fc.tuple(fc.constant(1), notPositive),
        ),
        (cls, [stepAttempt, receiveCount]) => {
          assert.throws(
            () => decideDurableStep({ outcome_class: cls, step_attempt: stepAttempt, receive_count: receiveCount }),
            RangeError,
          );
        },
      ),
      fuzzParameters(),
    );
  });
});
