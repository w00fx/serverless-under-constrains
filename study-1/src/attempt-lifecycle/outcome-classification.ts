// BR-RUA-021 / BR-RUA-022 outcome classes: which kind of evidence one physical attempt
// contributes to the request's effect knowledge.
//
// BR-RUA-021: `SUCCEEDED`, `REJECTED` and `TIMED_OUT` imply `DISPATCHED`; `FAILED` may carry
// any dispatch state. BR-RUA-022 (outcome classes): a pre-dispatch failure is `FAILED` with a
// proven `NOT_DISPATCHED`; a rejection is an authoritative `REJECTED`; a success is
// `SUCCEEDED`; an ambiguous outcome is `TIMED_OUT`, `FAILED` with `DISPATCHED`, or `FAILED`
// with `UNKNOWN` dispatch (BR-RUA-004).

import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { AttemptOutcome, DispatchState } from '../record-contract/records/group-b/vocabulary.ts';

export const OUTCOME_CLASSES = ['PRE_DISPATCH_FAILURE', 'REJECTION', 'SUCCESS', 'AMBIGUOUS'] as const;
/** The four columns of the BR-RUA-022 effect-knowledge table. */
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/** The `StructuredReason.code` of an outcome that claims a dispatch state BR-RUA-021 forbids. */
export const OUTCOME_DISPATCH_CONTRADICTION = 'OUTCOME_DISPATCH_CONTRADICTION';

/**
 * Classifies one attempt outcome together with its dispatch state. A `SUCCEEDED`, `REJECTED`
 * or `TIMED_OUT` outcome that is not `DISPATCHED` contradicts BR-RUA-021 and is returned as
 * an error instead of being guessed into a class.
 *
 * @example
 * classifyOutcome('FAILED', 'UNKNOWN'); // { ok: true, value: 'AMBIGUOUS' }
 * classifyOutcome('SUCCEEDED', 'NOT_DISPATCHED').ok; // false
 */
export function classifyOutcome(
  outcome: AttemptOutcome,
  dispatch: DispatchState,
): Result<OutcomeClass, StructuredReason> {
  if (outcome === 'FAILED') {
    return { ok: true, value: dispatch === 'NOT_DISPATCHED' ? 'PRE_DISPATCH_FAILURE' : 'AMBIGUOUS' };
  }
  if (dispatch !== 'DISPATCHED') {
    return {
      ok: false,
      error: {
        code: OUTCOME_DISPATCH_CONTRADICTION,
        subject: 'BR-RUA-021',
        detail: `outcome ${outcome} with dispatch state ${dispatch}; expected dispatch state DISPATCHED, because SUCCEEDED, REJECTED and TIMED_OUT imply DISPATCHED`,
      },
    };
  }
  return { ok: true, value: DISPATCHED_OUTCOME_CLASSES[outcome] };
}

const DISPATCHED_OUTCOME_CLASSES: Readonly<Record<Exclude<AttemptOutcome, 'FAILED'>, OutcomeClass>> = {
  SUCCEEDED: 'SUCCESS',
  REJECTED: 'REJECTION',
  TIMED_OUT: 'AMBIGUOUS',
};
