// A Smithy retry strategy that retries every failure at once, up to a fixed number of attempts.
// The client factory test smuggles it past `StoreClientSettings` to prove that the factory drops
// it: with it in force the SDK would send one request per attempt (WP-04 review round 1).

import type { RetryErrorInfo, RetryStrategyV2, RetryToken } from '@smithy/types';

class ImmediateRetryToken implements RetryToken {
  readonly #retryCount: number;

  constructor(retryCount: number) {
    this.#retryCount = retryCount;
  }

  getRetryCount(): number {
    return this.#retryCount;
  }

  getRetryDelay(): number {
    return 0;
  }
}

/**
 * Retries any error with no delay until `maxAttempts` requests have been sent.
 *
 * @example
 * const recorder = new RecordingDynamoDbClient({ retryStrategy: new EagerRetryStrategy(4) } as unknown as StoreClientSettings);
 */
export class EagerRetryStrategy implements RetryStrategyV2 {
  readonly #maxAttempts: number;

  constructor(maxAttempts: number) {
    this.#maxAttempts = maxAttempts;
  }

  acquireInitialRetryToken(_retryTokenScope: string): Promise<RetryToken> {
    return Promise.resolve(new ImmediateRetryToken(0));
  }

  refreshRetryTokenForRetry(tokenToRenew: RetryToken, _errorInfo: RetryErrorInfo): Promise<RetryToken> {
    const next = tokenToRenew.getRetryCount() + 1;
    if (next >= this.#maxAttempts) {
      return Promise.reject(
        new Error(`retry ${String(next)} refused; expected at most ${String(this.#maxAttempts)} attempts`),
      );
    }
    return Promise.resolve(new ImmediateRetryToken(next));
  }

  recordSuccess(_token: RetryToken): void {
    // Nothing to account: this strategy keeps no retry budget.
  }
}
