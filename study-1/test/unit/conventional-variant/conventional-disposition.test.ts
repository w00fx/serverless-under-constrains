// The conventional disposition table (BR-RUA-020, BR-RUA-024; AC-RUA-045 unit case "a
// conventional failed delivery before the second receive"): a definitive provider answer
// completes the delivery; an ambiguous or pre-dispatch failure propagates, and is
// RETRIES_EXHAUSTED only on the last receive (OR-RUA-002 maxReceiveCount 2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONVENTIONAL_MAX_RECEIVE_COUNT,
  DELIVERY_FAILURE_ERROR_NAME,
  decideConventionalDisposition,
} from '../../../src/conventional-variant/conventional-disposition.ts';
import type { OutcomeClass } from '../../../src/attempt-lifecycle/outcome-classification.ts';

const COMPLETE = { kind: 'complete' };
const PROPAGATE = { kind: 'propagate_failure', error_name: 'DeliveryFailurePropagated' };
const RUNNING = { processing_state: 'RUNNING', upstream_can_redeliver: true };
const EXHAUSTED = { processing_state: 'FINISHED', terminal_reason: 'RETRIES_EXHAUSTED' };

function decide(cls: OutcomeClass, receiveCount: number): unknown {
  return decideConventionalDisposition({ outcome_class: cls }, receiveCount, CONVENTIONAL_MAX_RECEIVE_COUNT);
}

describe('decideConventionalDisposition', () => {
  it('uses the OR-RUA-002 redrive threshold and the error name the handler throws', () => {
    assert.equal(CONVENTIONAL_MAX_RECEIVE_COUNT, 2);
    assert.equal(DELIVERY_FAILURE_ERROR_NAME, 'DeliveryFailurePropagated');
  });

  it('completes a success as SUCCEEDED and a provider rejection as PROVIDER_REJECTED on any receive', () => {
    for (const receive of [1, 2]) {
      assert.deepEqual(decide('SUCCESS', receive), {
        disposition: COMPLETE,
        terminality: { processing_state: 'FINISHED', terminal_reason: 'SUCCEEDED' },
      });
      assert.deepEqual(decide('REJECTION', receive), {
        disposition: COMPLETE,
        terminality: { processing_state: 'FINISHED', terminal_reason: 'PROVIDER_REJECTED' },
      });
    }
  });

  it('keeps a failed first delivery RUNNING, because the source can still redeliver (AC-RUA-045)', () => {
    assert.deepEqual(decide('AMBIGUOUS', 1), { disposition: PROPAGATE, terminality: RUNNING });
    assert.deepEqual(decide('PRE_DISPATCH_FAILURE', 1), { disposition: PROPAGATE, terminality: RUNNING });
  });

  it('finishes a failed last delivery as RETRIES_EXHAUSTED and still propagates it to the DLQ', () => {
    assert.deepEqual(decide('AMBIGUOUS', 2), { disposition: PROPAGATE, terminality: EXHAUSTED });
    assert.deepEqual(decide('PRE_DISPATCH_FAILURE', 2), { disposition: PROPAGATE, terminality: EXHAUSTED });
  });

  it('reads a receive count above the maximum as the last receive', () => {
    assert.deepEqual(decide('AMBIGUOUS', 3), { disposition: PROPAGATE, terminality: EXHAUSTED });
  });

  it('throws a RangeError for a receive count that is not a positive safe integer', () => {
    for (const count of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => decide('AMBIGUOUS', count), RangeError);
    }
  });
});
