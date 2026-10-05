// AC-RUA-045: terminality spans every retry layer (BR-RUA-024). A failed delivery or an
// exhausted inner execution is not request-level RETRIES_EXHAUSTED while an upstream layer can
// still redeliver. Receive counts follow BR-RUA-020 (`maxReceiveCount = 2`: one initial
// delivery plus one redelivery).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RetryLayerFacts } from '../../../src/attempt-lifecycle/terminality.ts';
import { decideTerminality } from '../../../src/attempt-lifecycle/terminality.ts';

const RUNNING = { processing_state: 'RUNNING', upstream_can_redeliver: true };
const EXHAUSTED = { processing_state: 'FINISHED', terminal_reason: 'RETRIES_EXHAUSTED' };

describe('AC-RUA-045 terminality spans every retry layer', () => {
  it('conventional-failed-before-second-receive: the first failed delivery is not RETRIES_EXHAUSTED', () => {
    const decision = decideTerminality({
      variant: 'conventional',
      receive_count: 1,
      max_receive_count: 2,
      attempt_ambiguous_or_failed: true,
    });
    assert.deepEqual(decision, RUNNING);
  });

  it('durable-exhausted-before-redelivery: an exhausted first execution is not RETRIES_EXHAUSTED', () => {
    const decision = decideTerminality({
      variant: 'durable',
      receive_count: 1,
      max_receive_count: 2,
      inner_execution_exhausted: true,
    });
    assert.deepEqual(decision, RUNNING);
  });

  it('conventional failure on the last allowed receive is RETRIES_EXHAUSTED', () => {
    assert.deepEqual(
      decideTerminality({
        variant: 'conventional',
        receive_count: 2,
        max_receive_count: 2,
        attempt_ambiguous_or_failed: true,
      }),
      EXHAUSTED,
    );
  });

  it('durable exhaustion on the last allowed receive is RETRIES_EXHAUSTED', () => {
    assert.deepEqual(
      decideTerminality({
        variant: 'durable',
        receive_count: 2,
        max_receive_count: 2,
        inner_execution_exhausted: true,
      }),
      EXHAUSTED,
    );
  });

  it('a receive count above the maximum (a throttle consumed a receive, RK-08) is RETRIES_EXHAUSTED', () => {
    assert.deepEqual(
      decideTerminality({
        variant: 'conventional',
        receive_count: 3,
        max_receive_count: 2,
        attempt_ambiguous_or_failed: true,
      }),
      EXHAUSTED,
    );
  });

  it('a source with more receives left keeps the request running', () => {
    assert.deepEqual(
      decideTerminality({
        variant: 'durable',
        receive_count: 2,
        max_receive_count: 3,
        inner_execution_exhausted: true,
      }),
      RUNNING,
    );
  });

  it('the probe has no retry layer, so its failed attempt is RETRIES_EXHAUSTED', () => {
    assert.deepEqual(decideTerminality({ variant: 'probe', attempt_ambiguous_or_failed: true }), EXHAUSTED);
  });

  it('facts without a failure are refused', () => {
    const noFailure: readonly RetryLayerFacts[] = [
      { variant: 'conventional', receive_count: 1, max_receive_count: 2, attempt_ambiguous_or_failed: false },
      { variant: 'durable', receive_count: 2, max_receive_count: 2, inner_execution_exhausted: false },
      { variant: 'probe', attempt_ambiguous_or_failed: false },
    ];
    for (const facts of noFailure) {
      assert.throws(() => decideTerminality(facts), {
        name: 'RangeError',
        message: `retry-layer facts ${JSON.stringify(facts)} describe no failure; expected attempt_ambiguous_or_failed or inner_execution_exhausted to be true`,
      });
    }
  });

  it('receive counts that are not positive safe integers are refused', () => {
    const counts: readonly (readonly [number, number])[] = [
      [0, 2],
      [1, 0],
      [1.5, 2],
      [1, 2.5],
      [Number.NaN, 2],
      [-1, 2],
      [1, Number.POSITIVE_INFINITY],
    ];
    for (const [receive, max] of counts) {
      assert.throws(
        () =>
          decideTerminality({
            variant: 'conventional',
            receive_count: receive,
            max_receive_count: max,
            attempt_ambiguous_or_failed: true,
          }),
        {
          name: 'RangeError',
          message: `receive_count ${String(receive)} and max_receive_count ${String(max)}; expected positive safe integers`,
        },
      );
    }
  });
});
