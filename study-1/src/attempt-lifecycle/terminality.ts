// BR-RUA-024 terminality across retry layers: "A failed delivery or exhausted inner execution
// is not request-level `RETRIES_EXHAUSTED` while an upstream layer can still redeliver."
//
// Retry layers per variant (BR-RUA-020): the conventional path owns one initial source
// delivery plus one redelivery (`maxReceiveCount = 2`); the Durable path owns one step
// attempt plus one step retry inside a durable execution, and a failed execution may still
// be redelivered by the source queue; the transport probe performs exactly one attempt and
// has no retry layer (BR-RUA-027).

/** The facts of one failed delivery (conventional), one exhausted inner execution (Durable) or the probe's one attempt. */
export type RetryLayerFacts =
  | {
      readonly variant: 'conventional';
      /** The SQS `ApproximateReceiveCount` of the delivery that failed (1 on the first receive). */
      readonly receive_count: number;
      readonly max_receive_count: number;
      readonly attempt_ambiguous_or_failed: boolean;
    }
  | {
      readonly variant: 'durable';
      /** The SQS `ApproximateReceiveCount` of the delivery that started the exhausted execution. */
      readonly receive_count: number;
      readonly max_receive_count: number;
      readonly inner_execution_exhausted: boolean;
    }
  | { readonly variant: 'probe'; readonly attempt_ambiguous_or_failed: boolean };

export type TerminalityDecision =
  | { readonly processing_state: 'RUNNING'; readonly upstream_can_redeliver: true }
  | { readonly processing_state: 'FINISHED'; readonly terminal_reason: 'RETRIES_EXHAUSTED' };

const STILL_RUNNING: TerminalityDecision = { processing_state: 'RUNNING', upstream_can_redeliver: true };
const RETRIES_EXHAUSTED: TerminalityDecision = { processing_state: 'FINISHED', terminal_reason: 'RETRIES_EXHAUSTED' };

/**
 * Decides whether a failed retry layer ends request processing. It is `RETRIES_EXHAUSTED`
 * only when no upstream layer can redeliver: the receive count has reached the source's
 * `maxReceiveCount` (the redrive policy then moves the message to the DLQ), or the caller is
 * the probe, which never retries.
 *
 * The facts must describe a failure: a success or a provider rejection finishes processing
 * through `SUCCEEDED` or `PROVIDER_REJECTED`, never through this decision, so a fact set
 * without a failure (or with counts that are not positive safe integers) throws a RangeError.
 *
 * @example
 * decideTerminality({ variant: 'conventional', receive_count: 1, max_receive_count: 2,
 *   attempt_ambiguous_or_failed: true }); // { processing_state: 'RUNNING', upstream_can_redeliver: true }
 */
export function decideTerminality(facts: RetryLayerFacts): TerminalityDecision {
  if (!describesFailure(facts)) {
    throw new RangeError(
      `retry-layer facts ${JSON.stringify(facts)} describe no failure; expected attempt_ambiguous_or_failed or inner_execution_exhausted to be true`,
    );
  }
  if (facts.variant === 'probe') {
    return RETRIES_EXHAUSTED;
  }
  assertReceiveCounts(facts.receive_count, facts.max_receive_count);
  return facts.receive_count < facts.max_receive_count ? STILL_RUNNING : RETRIES_EXHAUSTED;
}

function describesFailure(facts: RetryLayerFacts): boolean {
  return facts.variant === 'durable' ? facts.inner_execution_exhausted : facts.attempt_ambiguous_or_failed;
}

function assertReceiveCounts(receiveCount: number, maxReceiveCount: number): void {
  if (!isPositiveSafeInteger(receiveCount) || !isPositiveSafeInteger(maxReceiveCount)) {
    throw new RangeError(
      `receive_count ${String(receiveCount)} and max_receive_count ${String(maxReceiveCount)}; expected positive safe integers`,
    );
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}
