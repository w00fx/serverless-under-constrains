// What one Durable step attempt decides after its provider attempt (BR-RUA-020, BR-RUA-024,
// design §5.3). A success or a provider rejection finishes the request and completes the step,
// so the execution succeeds and the event source mapping deletes the message. Any other outcome
// (ambiguous or failed before dispatch) fails the step: before the last step attempt the inner
// layer still retries, so processing keeps running; at the last step attempt the inner execution
// is exhausted, and it is request-level RETRIES_EXHAUSTED only when the source cannot redeliver
// either, which is the receive at `maxReceiveCount` (AC-RUA-045; design §8.7 accepts a recorded
// RETRIES_EXHAUSTED only then). The failed execution then lets SQS redeliver the message, which
// starts a new execution, or move it to the DLQ.

import type { OutcomeClass } from '../attempt-lifecycle/outcome-classification.ts';
import { decideTerminality } from '../attempt-lifecycle/terminality.ts';
import type { TerminalityDecision } from '../attempt-lifecycle/terminality.ts';
import { DURABLE_STEP_ATTEMPTS } from './durable-retry.ts';

/** OR-RUA-002: the Durable source queue's redrive threshold. */
export const DURABLE_MAX_RECEIVE_COUNT = 2;

/** A finished request after a definitive provider answer. */
export interface DurableDefinitiveFinish {
  readonly processing_state: 'FINISHED';
  readonly terminal_reason: 'SUCCEEDED' | 'PROVIDER_REJECTED';
}

/** The outcome classes that fail a step attempt. */
export type FailedStepClass = Exclude<OutcomeClass, 'SUCCESS' | 'REJECTION'>;

export type DurableStepDisposition =
  | { readonly kind: 'complete'; readonly terminality: DurableDefinitiveFinish }
  | {
      readonly kind: 'retry_step' | 'inner_exhausted';
      readonly failed_class: FailedStepClass;
      readonly terminality: TerminalityDecision;
    };

/** The facts one step attempt decides on. */
export interface DurableStepFacts {
  readonly outcome_class: OutcomeClass;
  /** The SDK's 1-based step attempt number. */
  readonly step_attempt: number;
  /** The SQS `ApproximateReceiveCount` of the delivery that started the execution. */
  readonly receive_count: number;
}

const DEFINITIVE_FINISHES: Readonly<Record<Extract<OutcomeClass, 'SUCCESS' | 'REJECTION'>, DurableDefinitiveFinish>> = {
  SUCCESS: { processing_state: 'FINISHED', terminal_reason: 'SUCCEEDED' },
  REJECTION: { processing_state: 'FINISHED', terminal_reason: 'PROVIDER_REJECTED' },
};

/**
 * The request-level terminality of an exhausted inner execution: RUNNING while the source can
 * still redeliver, RETRIES_EXHAUSTED at the source's last receive. A receive count above the
 * maximum cannot come from SQS (the redrive moves the message first); it is read as the last
 * receive, so the decision never claims a redelivery that cannot happen. Pure. Throws a
 * RangeError only for a receive count that is not a positive safe integer.
 *
 * @example
 * decideDurableExhaustion(1, 2); // { processing_state: 'RUNNING', upstream_can_redeliver: true }
 * decideDurableExhaustion(2, 2); // { processing_state: 'FINISHED', terminal_reason: 'RETRIES_EXHAUSTED' }
 */
export function decideDurableExhaustion(
  receiveCount: number,
  maxReceiveCount: typeof DURABLE_MAX_RECEIVE_COUNT,
): TerminalityDecision {
  // Checked before clamping: Math.min would turn Infinity or an unsafe count into a valid 2
  // (fuzz counterexample seed -1274475116, path "4:0").
  assertPositiveSafeInteger('receive_count', receiveCount);
  return decideTerminality({
    variant: 'durable',
    receive_count: Math.min(receiveCount, maxReceiveCount),
    max_receive_count: maxReceiveCount,
    inner_execution_exhausted: true,
  });
}

/**
 * Decides what one step attempt does with the request after its provider attempt. Pure.
 * Throws a RangeError for a step attempt or receive count that is not a positive safe integer.
 *
 * @example
 * decideDurableStep({ outcome_class: 'AMBIGUOUS', step_attempt: 1, receive_count: 1 });
 * // { kind: 'retry_step', failed_class: 'AMBIGUOUS',
 * //   terminality: { processing_state: 'RUNNING', upstream_can_redeliver: true } }
 */
export function decideDurableStep(facts: DurableStepFacts): DurableStepDisposition {
  assertPositiveSafeInteger('step_attempt', facts.step_attempt);
  assertPositiveSafeInteger('receive_count', facts.receive_count);
  const cls = facts.outcome_class;
  if (cls === 'SUCCESS' || cls === 'REJECTION') {
    return { kind: 'complete', terminality: DEFINITIVE_FINISHES[cls] };
  }
  if (facts.step_attempt >= DURABLE_STEP_ATTEMPTS) {
    return {
      kind: 'inner_exhausted',
      failed_class: cls,
      terminality: decideDurableExhaustion(facts.receive_count, DURABLE_MAX_RECEIVE_COUNT),
    };
  }
  const terminality = decideTerminality({
    variant: 'durable',
    receive_count: Math.min(facts.receive_count, DURABLE_MAX_RECEIVE_COUNT),
    max_receive_count: DURABLE_MAX_RECEIVE_COUNT,
    inner_execution_exhausted: false,
  });
  return { kind: 'retry_step', failed_class: cls, terminality };
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} ${String(value)}; expected a positive safe integer`);
  }
}
