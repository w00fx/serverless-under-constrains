// Property-based tests of the conventional disposition (BR-RUA-020, BR-RUA-024; AC-RUA-045):
// over every outcome class and every positive receive count, a definitive provider answer
// always completes the delivery and finishes the request, and a non-definitive one always
// propagates the failure, finishing RETRIES_EXHAUSTED exactly when the receive count reached the
// redrive threshold, so a request never finishes while SQS can still redeliver it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { OUTCOME_CLASSES } from '../../../src/attempt-lifecycle/outcome-classification.ts';
import {
  CONVENTIONAL_MAX_RECEIVE_COUNT,
  decideConventionalDisposition,
} from '../../../src/conventional-variant/conventional-disposition.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const receiveCount = fc.oneof(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }));

describe('decideConventionalDisposition properties', () => {
  it('completes exactly the definitive answers and never exhausts retries before the threshold', () => {
    fc.assert(
      fc.property(fc.constantFrom(...OUTCOME_CLASSES), receiveCount, (outcomeClass, count) => {
        const decision = decideConventionalDisposition(
          { outcome_class: outcomeClass },
          count,
          CONVENTIONAL_MAX_RECEIVE_COUNT,
        );
        const definitive = outcomeClass === 'SUCCESS' || outcomeClass === 'REJECTION';
        assert.equal(decision.disposition.kind, definitive ? 'complete' : 'propagate_failure');
        if (definitive) {
          assert.equal(decision.terminality.processing_state, 'FINISHED');
          return;
        }
        const exhausted = count >= CONVENTIONAL_MAX_RECEIVE_COUNT;
        assert.deepEqual(
          decision.terminality,
          exhausted
            ? { processing_state: 'FINISHED', terminal_reason: 'RETRIES_EXHAUSTED' }
            : { processing_state: 'RUNNING', upstream_can_redeliver: true },
        );
      }),
      fuzzParameters(),
    );
  });
});
