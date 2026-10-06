// BR-RUA-024 terminality across retry layers: "A failed delivery or exhausted inner execution
// is not request-level `RETRIES_EXHAUSTED` while an upstream layer can still redeliver."
//
// Retry layers per variant (BR-RUA-020): the conventional path owns one initial source
// delivery plus one redelivery (`maxReceiveCount = 2`); the Durable path owns one step
// attempt plus one step retry inside a durable execution, and a failed execution may still
// be redelivered by the source queue; the transport probe performs exactly one attempt and
// has no retry layer (BR-RUA-027).

/** The facts of one failed delivery (conventional), one Durable execution's inner retry layer, or the probe's one attempt. */
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
      /** The SQS `ApproximateReceiveCount` of the delivery that started the execution. */
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
 * only when no upstream layer can redeliver: the deciding receive is the source's last
 * (`receive_count == max_receive_count`, after which the redrive policy moves the message to
 * the DLQ; design §8.7 accepts a recorded `RETRIES_EXHAUSTED` only then), or the caller is the
 * probe, which never retries. A Durable execution whose inner layer is not exhausted can still
 * retry its step, so processing keeps running (BR-RUA-024).
 *
 * Throws a RangeError for facts that fit no decision: a conventional or probe attempt without
 * a failure (a success or a provider rejection finishes through `SUCCEEDED` or
 * `PROVIDER_REJECTED`, never through this decision), counts that are not positive safe
 * integers, or a receive count above the maximum (SQS never delivers past the redrive
 * threshold; a throttle that consumes a receive, RK-08, makes the first real invocation see
 * `receive_count == max_receive_count`, not more).
 *
 * @example
 * decideTerminality({ variant: 'conventional', receive_count: 1, max_receive_count: 2,
 *   attempt_ambiguous_or_failed: true }); // { processing_state: 'RUNNING', upstream_can_redeliver: true }
 */
export function decideTerminality(facts: RetryLayerFacts): TerminalityDecision {
  if (facts.variant === 'probe') {
    assertFailure(facts, facts.attempt_ambiguous_or_failed);
    return RETRIES_EXHAUSTED;
  }
  assertReceiveCounts(facts.receive_count, facts.max_receive_count);
  if (facts.variant === 'durable' && !facts.inner_execution_exhausted) {
    return STILL_RUNNING;
  }
  if (facts.variant === 'conventional') {
    assertFailure(facts, facts.attempt_ambiguous_or_failed);
  }
  return facts.receive_count < facts.max_receive_count ? STILL_RUNNING : RETRIES_EXHAUSTED;
}

function assertFailure(facts: RetryLayerFacts, failed: boolean): void {
  if (!failed) {
    throw new RangeError(
      `retry-layer facts ${JSON.stringify(facts)} describe no failure; expected attempt_ambiguous_or_failed to be true`,
    );
  }
}

function assertReceiveCounts(receiveCount: number, maxReceiveCount: number): void {
  if (!isPositiveSafeInteger(receiveCount) || !isPositiveSafeInteger(maxReceiveCount)) {
    throw new RangeError(
      `receive_count ${String(receiveCount)} and max_receive_count ${String(maxReceiveCount)}; expected positive safe integers`,
    );
  }
  if (receiveCount > maxReceiveCount) {
    throw new RangeError(
      `receive_count ${String(receiveCount)} above max_receive_count ${String(maxReceiveCount)}; expected receive_count <= max_receive_count, because the redrive policy moves the message to the DLQ after the last receive`,
    );
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}
