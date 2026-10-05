// The durable attempt-state port of BR-RUA-021 (design §5.3 `AttemptStatePort`, the
// durable-transition double of AC-RUA-015). Every physical attempt begins in a durable
// `PRE_DISPATCH` state, written in one transaction with its `attempt_registered` event. Each
// later transition is conditional on `PRE_DISPATCH` and carries its journal event in the same
// transaction, so the event exists exactly when the transition applied:
// - `PRE_DISPATCH -> NOT_DISPATCHED` with `attempt_not_dispatched` is the only proof that the
//   attempt failed before provider-client dispatch began;
// - `PRE_DISPATCH -> DISPATCHED` with `dispatch_started` is the dispatch boundary, after which
//   the attempt stays conservatively dispatched.

import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import type { PreparedJournalPut } from '../event-journal/journal-writer.ts';
import type { Uuid4 } from '../record-contract/primitives.ts';
import type { AttemptCorrelation } from '../record-contract/records/group-b/shared-shapes.ts';

/** The durable phases of one attempt. */
export const ATTEMPT_PHASES = ['PRE_DISPATCH', 'NOT_DISPATCHED', 'DISPATCHED'] as const;
export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];

/** The identities the pre-dispatch registration stores (INV-RUA-001). */
export type AttemptRegistration = AttemptCorrelation;

export interface AttemptStatePort {
  /** Writes the `PRE_DISPATCH` state (condition: absent) and `event` in one transaction. */
  registerPreDispatch(registration: AttemptRegistration, event: PreparedJournalPut): Promise<WriteOutcome>;
  /** `PRE_DISPATCH -> NOT_DISPATCHED` (condition: phase = PRE_DISPATCH) with `event`, atomically. */
  transitionToNotDispatched(attemptId: Uuid4, event: PreparedJournalPut): Promise<WriteOutcome>;
  /** `PRE_DISPATCH -> DISPATCHED` (condition: phase = PRE_DISPATCH) with `event`, atomically. */
  transitionToDispatched(attemptId: Uuid4, event: PreparedJournalPut): Promise<WriteOutcome>;
}

/** The sort-key prefix of attempt-state items in the caller journal (design §9.3). */
export const ATTEMPT_STATE_SK_PREFIX = 'state#attempt#';

/**
 * The sort key of one attempt's state item: `state#attempt#<attempt_id>` (design §9.3).
 *
 * @example
 * attemptStateSortKey('dddddddd-0000-4000-8000-000000000001' as Uuid4); // 'state#attempt#dddddddd-0000-4000-8000-000000000001'
 */
export function attemptStateSortKey(attemptId: Uuid4): string {
  return `${ATTEMPT_STATE_SK_PREFIX}${attemptId}`;
}
