// The Durable variant's inner retry layer (BR-RUA-020, OR-RUA-002, D-11): one initial step
// attempt plus one explicit step retry, a fixed delay and no jitter. The strategy is written by
// hand instead of through the SDK's `createRetryStrategy`, whose defaults (3 attempts, backoff
// rate 2, FULL jitter) apply to any field left out, and whose omission falls back to 6 attempts
// with FULL jitter (durable-functions research §2.3, risks R1 and R2). The SDK calls the strategy
// with the 1-based number of the attempt that just failed (`dist/index.mjs` L2158-2160).

/** OR-RUA-002: Durable total step attempts. */
export const DURABLE_STEP_ATTEMPTS = 2;

/** OR-RUA-002: Durable retry delay, in seconds after the failed attempt. */
export const DURABLE_RETRY_DELAY_SECONDS = 60;

/** The inner retry layer's configuration: 60 s when deployed, injected shorter in tests (RK-09). */
export interface DurableRetryConfig {
  readonly attempts: typeof DURABLE_STEP_ATTEMPTS;
  readonly delay_seconds: number;
}

/** The configuration every deployed Durable caller runs with (OR-RUA-002). */
export const DEPLOYED_DURABLE_RETRY: DurableRetryConfig = {
  attempts: DURABLE_STEP_ATTEMPTS,
  delay_seconds: DURABLE_RETRY_DELAY_SECONDS,
};

/** The SDK's `RetryDecision`, restated so the pure strategy needs no SDK import. */
export type StepRetryDecision =
  { readonly shouldRetry: true; readonly delay: { readonly seconds: number } } | { readonly shouldRetry: false };

/** The SDK's step `retryStrategy` signature. */
export type StepRetryStrategy = (error: Error, attemptsMade: number) => StepRetryDecision;

const STOP: StepRetryDecision = { shouldRetry: false };

/**
 * Builds the step retry strategy: retry after `delay_seconds` while fewer than `attempts` step
 * attempts were made, then stop. Every error is retried the same way, because an ambiguous
 * attempt and a caller fault both leave the request to the next step attempt. Pure. Throws a
 * RangeError at construction for a delay that is not a positive safe integer (the SDK accepts
 * only positive integer durations).
 *
 * @example
 * const strategy = createStepRetryStrategy({ attempts: 2, delay_seconds: 60 });
 * strategy(new Error('timed out'), 1); // { shouldRetry: true, delay: { seconds: 60 } }
 * strategy(new Error('timed out'), 2); // { shouldRetry: false }
 */
export function createStepRetryStrategy(cfg: DurableRetryConfig): StepRetryStrategy {
  if (!Number.isSafeInteger(cfg.delay_seconds) || cfg.delay_seconds < 1) {
    throw new RangeError(
      `Durable retry delay_seconds ${String(cfg.delay_seconds)}; expected a positive safe integer number of seconds`,
    );
  }
  const retry: StepRetryDecision = { shouldRetry: true, delay: { seconds: cfg.delay_seconds } };
  return (_error: Error, attemptsMade: number): StepRetryDecision => (attemptsMade < cfg.attempts ? retry : STOP);
}
