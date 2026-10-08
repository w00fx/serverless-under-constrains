// BR-RUA-021 dispatch classification from durable evidence.
//
// "Every physical attempt begins in a durable pre-dispatch state. `NOT_DISPATCHED` requires a
// conditional durable transition proving the attempt failed before provider-client dispatch
// began. Absence of a dispatch event, provider call, or ledger effect does not prove
// `NOT_DISPATCHED`. ... A crash after that boundary remains conservatively dispatched."
//
// The evidence type deliberately has no field for provider calls or ledger effects: their
// absence can never prove non-dispatch, so they cannot take part in the decision (AC-RUA-028).

import type { DispatchState } from '../record-contract/records/group-b/vocabulary.ts';

/**
 * What durable evidence shows about one attempt. `true` means the record is present, `false`
 * that the evidence is complete and proves it absent, and `'unknown'` that the evidence cannot
 * tell (for example a gapped journal).
 */
export interface DispatchEvidence {
  /** `attempt_registered` and the `PRE_DISPATCH` attempt state, written in one transaction. */
  readonly pre_dispatch_registered: boolean | 'unknown';
  /** The applied conditional transition `PRE_DISPATCH -> NOT_DISPATCHED` (`attempt_not_dispatched`). */
  readonly not_dispatched_transition_recorded: boolean | 'unknown';
  /** `dispatch_started`, written with the conditional `PRE_DISPATCH -> DISPATCHED` transition. */
  readonly dispatch_started_recorded: boolean | 'unknown';
}

/**
 * Classifies dispatch:
 * - `DISPATCHED` when `dispatch_started` is recorded: the boundary was crossed, whatever
 *   happened afterwards;
 * - `NOT_DISPATCHED` only when the conditional `NOT_DISPATCHED` transition is recorded and the
 *   pre-dispatch registration is not proven absent (the transition is conditional on it);
 * - `UNKNOWN` otherwise, including every case that rests on the absence of a record.
 *
 * @example
 * classifyDispatch({ pre_dispatch_registered: true, not_dispatched_transition_recorded: false,
 *   dispatch_started_recorded: true }); // 'DISPATCHED'
 * classifyDispatch({ pre_dispatch_registered: true, not_dispatched_transition_recorded: false,
 *   dispatch_started_recorded: false }); // 'UNKNOWN': absence proves nothing
 */
export function classifyDispatch(e: DispatchEvidence): DispatchState {
  if (e.dispatch_started_recorded === true) {
    return 'DISPATCHED';
  }
  if (e.not_dispatched_transition_recorded === true && e.pre_dispatch_registered !== false) {
    return 'NOT_DISPATCHED';
  }
  return 'UNKNOWN';
}
