// What the conventional consumer does with a delivery after its one attempt (BR-RUA-020,
// BR-RUA-024, design §5.3): a success or a provider rejection completes the delivery, so the
// event source mapping deletes the message; an ambiguous or pre-dispatch failure propagates as
// an invocation failure, so the message returns after the visibility timeout. The source owns
// one initial delivery plus one redelivery (OR-RUA-002 `maxReceiveCount = 2`), so the failure
// of the first receive keeps processing RUNNING (AC-RUA-045) and only the failure of the last
// receive finishes it as RETRIES_EXHAUSTED. The redrive policy then moves the message to the
// DLQ on the next receive, which the oracle reads as the same terminal evidence (design §8.7).

import type { OutcomeClass } from '../attempt-lifecycle/outcome-classification.ts';
import { decideTerminality } from '../attempt-lifecycle/terminality.ts';
import type { TerminalityDecision } from '../attempt-lifecycle/terminality.ts';
import type { AttemptReport } from '../provider-client/attempt-resolution.ts';

/** OR-RUA-002: the source queue's redrive threshold. */
export const CONVENTIONAL_MAX_RECEIVE_COUNT = 2;

/** The error name the Lambda handler throws so the event source mapping keeps the message. */
export const DELIVERY_FAILURE_ERROR_NAME = 'DeliveryFailurePropagated';

export type ConventionalDisposition =
  | { readonly kind: 'complete' }
  | { readonly kind: 'propagate_failure'; readonly error_name: typeof DELIVERY_FAILURE_ERROR_NAME };

/** A finished request after a definitive provider answer. */
export interface DefinitiveFinish {
  readonly processing_state: 'FINISHED';
  readonly terminal_reason: 'SUCCEEDED' | 'PROVIDER_REJECTED';
}

export type ConventionalTerminality = TerminalityDecision | DefinitiveFinish;

export interface ConventionalDecision {
  readonly disposition: ConventionalDisposition;
  readonly terminality: ConventionalTerminality;
}

const COMPLETE: ConventionalDisposition = { kind: 'complete' };
const PROPAGATE: ConventionalDisposition = { kind: 'propagate_failure', error_name: DELIVERY_FAILURE_ERROR_NAME };

const DEFINITIVE_FINISHES: Readonly<Record<Extract<OutcomeClass, 'SUCCESS' | 'REJECTION'>, DefinitiveFinish>> = {
  SUCCESS: { processing_state: 'FINISHED', terminal_reason: 'SUCCEEDED' },
  REJECTION: { processing_state: 'FINISHED', terminal_reason: 'PROVIDER_REJECTED' },
};

/**
 * Decides the disposition of a delivery and the request's processing after its attempt. Pure.
 * A receive count above the maximum cannot come from SQS (the redrive moves the message first);
 * it is read as the last receive, so the decision never claims a redelivery that cannot happen.
 * Throws a RangeError only for a receive count that is not a positive safe integer.
 *
 * @example
 * decideConventionalDisposition(timedOutReport, 1, 2);
 * // { disposition: { kind: 'propagate_failure', ... }, terminality: { processing_state: 'RUNNING', ... } }
 */
export function decideConventionalDisposition(
  report: Pick<AttemptReport, 'outcome_class'>,
  receiveCount: number,
  maxReceiveCount: typeof CONVENTIONAL_MAX_RECEIVE_COUNT,
): ConventionalDecision {
  const cls = report.outcome_class;
  if (cls === 'SUCCESS' || cls === 'REJECTION') {
    return { disposition: COMPLETE, terminality: DEFINITIVE_FINISHES[cls] };
  }
  const terminality = decideTerminality({
    variant: 'conventional',
    receive_count: Math.min(receiveCount, maxReceiveCount),
    max_receive_count: maxReceiveCount,
    attempt_ambiguous_or_failed: true,
  });
  return { disposition: PROPAGATE, terminality };
}
