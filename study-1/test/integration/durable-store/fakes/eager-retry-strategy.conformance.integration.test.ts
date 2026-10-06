// Conformance of EagerRetryStrategy with the Smithy `RetryStrategyV2` contract it implements
// (@smithy/types retry.d.ts): the initial token has retry count 0, each refresh adds one with no
// delay, and the refresh that would exceed `maxAttempts` requests is refused, which ends the
// SDK's retry loop.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EagerRetryStrategy } from '../../../support/durable-store/aws/eager-retry-strategy.ts';

describe('EagerRetryStrategy contract', () => {
  it('allows maxAttempts requests with no delay, then refuses', async () => {
    const strategy = new EagerRetryStrategy(3);
    const first = await strategy.acquireInitialRetryToken('dynamodb');
    assert.equal(first.getRetryCount(), 0);
    assert.equal(first.getRetryDelay(), 0);
    const second = await strategy.refreshRetryTokenForRetry(first, { errorType: 'SERVER_ERROR' });
    assert.equal(second.getRetryCount(), 1);
    assert.equal(second.getRetryDelay(), 0);
    const third = await strategy.refreshRetryTokenForRetry(second, { errorType: 'SERVER_ERROR' });
    assert.equal(third.getRetryCount(), 2);
    await assert.rejects(strategy.refreshRetryTokenForRetry(third, { errorType: 'SERVER_ERROR' }), {
      message: 'retry 3 refused; expected at most 3 attempts',
    });
    strategy.recordSuccess(third);
  });
});
