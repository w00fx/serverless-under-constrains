// The Durable inner retry layer (BR-RUA-020, OR-RUA-002, D-11): two total step attempts, a fixed
// 60 s delay when deployed and no jitter. The SDK calls the strategy with the 1-based number of
// the attempt that just failed (durable-functions research §2.3), so attempt 1 retries and
// attempt 2 stops.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEPLOYED_DURABLE_RETRY,
  DURABLE_RETRY_DELAY_SECONDS,
  DURABLE_STEP_ATTEMPTS,
  createStepRetryStrategy,
} from '../../../src/durable-variant/durable-retry.ts';

const FAILURE = new Error('step attempt failed');

describe('createStepRetryStrategy', () => {
  it('deploys OR-RUA-002: 2 total step attempts and a 60 s retry delay', () => {
    assert.equal(DURABLE_STEP_ATTEMPTS, 2);
    assert.equal(DURABLE_RETRY_DELAY_SECONDS, 60);
    assert.deepEqual(DEPLOYED_DURABLE_RETRY, { attempts: 2, delay_seconds: 60 });
  });

  it('retries after the first failed attempt with the fixed delay, then stops', () => {
    const strategy = createStepRetryStrategy(DEPLOYED_DURABLE_RETRY);
    assert.deepEqual(strategy(FAILURE, 1), { shouldRetry: true, delay: { seconds: 60 } });
    assert.deepEqual(strategy(FAILURE, 2), { shouldRetry: false });
    assert.deepEqual(strategy(FAILURE, 3), { shouldRetry: false });
  });

  it('has no jitter: every retry decision carries the same delay', () => {
    const strategy = createStepRetryStrategy(DEPLOYED_DURABLE_RETRY);
    const delays = Array.from({ length: 50 }, () => strategy(FAILURE, 1));
    assert.deepEqual(new Set(delays.map((decision) => JSON.stringify(decision))).size, 1);
  });

  it('retries every error the same way, whatever its name', () => {
    const strategy = createStepRetryStrategy({ attempts: 2, delay_seconds: 1 });
    const fault = new Error('registry unreadable');
    fault.name = 'DurableCallerFault';
    assert.deepEqual(strategy(fault, 1), { shouldRetry: true, delay: { seconds: 1 } });
    assert.deepEqual(strategy(fault, 2), { shouldRetry: false });
  });

  it('accepts the injected 1 s test delay (RK-09) and refuses a delay the SDK cannot take', () => {
    assert.deepEqual(createStepRetryStrategy({ attempts: 2, delay_seconds: 1 })(FAILURE, 1), {
      shouldRetry: true,
      delay: { seconds: 1 },
    });
    for (const delay of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      assert.throws(() => createStepRetryStrategy({ attempts: 2, delay_seconds: delay }), {
        name: 'RangeError',
        message: `Durable retry delay_seconds ${String(delay)}; expected a positive safe integer number of seconds`,
      });
    }
  });
});
