// The attempt-state port over the durable item store (design §9.3): attempt-state items live in
// the caller journal next to the caller's events, under `state#attempt#<attempt_id>` in the
// partition of the journal event they travel with. Each operation is one `TransactWriteItems`
// holding the journal put and the state write, so the event exists exactly when the state
// changed (BR-RUA-021). The transaction token is the event id, which is fresh per event and at
// most 36 characters (F-1). The client resubmits a transaction only as the BR-RUA-033 identical
// retry after a definitive failure: the same reserved event, so the same token with the same
// actions, never a replay with changed parameters (`IdempotentParameterMismatchException`). What
// DynamoDB returns for a replay after a cancelled transaction is UNVERIFIED (design U-14); a
// repeated refusal only uses up the retry budget, and an ambiguous answer stops the writer.

import type { DurableItemStore, StoredItem, WriteAction, WriteOutcome } from '../durable-store/item-store-port.ts';
import { journalPutAction } from '../event-journal/journal-entry.ts';
import type { PreparedJournalPut } from '../event-journal/journal-writer.ts';
import type { Uuid4 } from '../record-contract/primitives.ts';
import type { AttemptPhase, AttemptRegistration, AttemptStatePort } from './attempt-state-port.ts';
import { attemptStateSortKey } from './attempt-state-port.ts';

/** The journal table that holds caller events and caller state (design §9.3). */
export const ATTEMPT_STATE_TABLE = 'caller_journal';

/**
 * Binds the attempt-state port to the caller-journal table of `store`.
 *
 * @example
 * const attempts = createDurableAttemptStatePort(store);
 * await attempts.registerPreDispatch({ attempt_id, provider_request_id, refund_request_id }, prepared.put);
 */
export function createDurableAttemptStatePort(store: DurableItemStore): AttemptStatePort {
  return {
    registerPreDispatch: (registration, event) =>
      store.transact(
        [journalPutAction(ATTEMPT_STATE_TABLE, event), registrationPut(registration, event)],
        event.event.event_id,
      ),
    transitionToNotDispatched: (attemptId, event) => transition(store, attemptId, event, 'NOT_DISPATCHED'),
    transitionToDispatched: (attemptId, event) => transition(store, attemptId, event, 'DISPATCHED'),
  };
}

function registrationPut(registration: AttemptRegistration, event: PreparedJournalPut): WriteAction {
  const item: StoredItem = {
    pk: event.key.pk,
    sk: attemptStateSortKey(registration.attempt_id),
    attempt_id: registration.attempt_id,
    provider_request_id: registration.provider_request_id,
    refund_request_id: registration.refund_request_id,
    phase: 'PRE_DISPATCH' satisfies AttemptPhase,
  };
  return { kind: 'put', table: ATTEMPT_STATE_TABLE, item, condition: { kind: 'item_absent' } };
}

function transition(
  store: DurableItemStore,
  attemptId: Uuid4,
  event: PreparedJournalPut,
  to: Exclude<AttemptPhase, 'PRE_DISPATCH'>,
): Promise<WriteOutcome> {
  const update: WriteAction = {
    kind: 'update',
    table: ATTEMPT_STATE_TABLE,
    key: { pk: event.key.pk, sk: attemptStateSortKey(attemptId) },
    set: { phase: to },
    condition: { kind: 'attribute_equals', name: 'phase', value: 'PRE_DISPATCH' satisfies AttemptPhase },
  };
  return store.transact([journalPutAction(ATTEMPT_STATE_TABLE, event), update], event.event.event_id);
}
