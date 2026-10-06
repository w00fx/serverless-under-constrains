// The provider commit (BR-RUA-016, BR-RUA-025, design §9.3, D-23): one TransactWriteItems that
// puts the immutable SUCCEEDED ledger transaction, puts `provider_transaction_committed`, and,
// for the targeted call, moves treatment `ARMED -> COMMITTED_WAITING` while recording the
// attempt, provider request, provider call, transaction and commit identities. Every plan
// draws fresh identities, and its ClientRequestToken is its own `provider_commit_id`, so an
// untargeted re-plan after a lost treatment race never reuses a token with changed parameters
// (F-1 `IdempotentParameterMismatch`). The provider never retries a commit.

import type { UpdateAction, WriteAction } from '../durable-store/item-store-port.ts';
import type { PreparedJournalPut } from '../event-journal/journal-writer.ts';
import { journalPutAction } from '../event-journal/journal-entry.ts';
import type { EventBody } from '../event-journal/journal-event.ts';
import type { Uuid4, UuidSource, UtcMillis } from '../record-contract/primitives.ts';
import type { LedgerTransaction } from '../record-contract/records/group-b/ledger_snapshot.ts';
import type { AcceptedCall } from './acceptance.ts';
import { TREATMENT_SORT_KEY } from './control-items.ts';

export const LEDGER_SORT_KEY_PREFIX = 'tx#';

/** The provider-generated identities one plan shares (BR-RUA-025). */
export interface CommitIdentities {
  readonly provider_commit_id: Uuid4;
  readonly provider_transaction_id: Uuid4;
}

/** The identities plus the id of the in-transaction commit event. */
export interface CommitIds extends CommitIdentities {
  readonly commit_event_id: Uuid4;
}

export type CommitKind = 'targeted' | 'untargeted';

/**
 * The position of the `provider_transaction_committed` put in every commit plan: after the
 * ledger put (index 0), before the treatment update of a targeted plan. The writer's `confirm`
 * needs it to tell a failed condition on the put itself from a failed business condition
 * (WP-05 review round 2).
 */
export const COMMIT_JOURNAL_ACTION_INDEX = 1;

export interface CommitPlan {
  readonly kind: CommitKind;
  readonly ids: CommitIds;
  readonly provider_call_id: Uuid4;
  readonly commit_requested_at: UtcMillis;
  readonly actions: readonly WriteAction[];
  /** Position of the treatment update in `actions`; present exactly for a targeted plan. */
  readonly treatment_action_index?: number;
}

export interface CommitPlanInput {
  readonly kind: CommitKind;
  readonly partition: string;
  readonly call: AcceptedCall;
  readonly provider_call_id: Uuid4;
  readonly identities: CommitIdentities;
  readonly commit_requested_at: UtcMillis;
  /** The `provider_transaction_committed` put reserved by the provider's journal writer. */
  readonly commit_event: PreparedJournalPut;
}

/**
 * Draws fresh commit identities for one plan (D-23).
 *
 * @example
 * const identities = drawCommitIdentities(uuids);
 */
export function drawCommitIdentities(ids: UuidSource): CommitIdentities {
  return { provider_commit_id: ids.next(), provider_transaction_id: ids.next() };
}

/**
 * The body of `provider_transaction_committed`, which the commit transaction writes.
 *
 * @example
 * journal.prepare('provider_transaction_committed', commitEventBody(call, callId, identities, true, requestedAt), [acceptedId]);
 */
export function commitEventBody(
  call: AcceptedCall,
  providerCallId: Uuid4,
  identities: CommitIdentities,
  targeted: boolean,
  requestedAt: UtcMillis,
): EventBody<'provider_transaction_committed'> {
  return {
    provider_commit_id: identities.provider_commit_id,
    provider_transaction_id: identities.provider_transaction_id,
    provider_call_id: providerCallId,
    attempt_id: call.attempt_id,
    provider_request_id: call.provider_request_id,
    refund_request_id: call.refund_request_id,
    payment_id: call.payment_id,
    amount_minor: call.amount_minor,
    currency: call.currency,
    targeted,
    commit_requested_at: requestedAt,
  };
}

/**
 * Builds the commit transaction. Pure: it only arranges what the caller drew and prepared.
 *
 * @example
 * const plan = planCommit({ kind: 'targeted', partition, call, provider_call_id, identities, commit_requested_at, commit_event });
 * const outcome = await state.commit(plan);
 */
export function planCommit(input: CommitPlanInput): CommitPlan {
  const ids: CommitIds = { ...input.identities, commit_event_id: input.commit_event.event.event_id };
  const shared = [
    {
      kind: 'put',
      table: 'ledger',
      item: { pk: input.partition, sk: ledgerSortKey(ids.provider_transaction_id), ...ledgerTransactionOf(input) },
      condition: { kind: 'item_absent' },
    },
    journalPutAction('experiment_journal', input.commit_event),
  ] as const satisfies readonly WriteAction[];
  const plan = {
    kind: input.kind,
    ids,
    provider_call_id: input.provider_call_id,
    commit_requested_at: input.commit_requested_at,
  };
  if (input.kind === 'untargeted') {
    return { ...plan, actions: shared };
  }
  return { ...plan, actions: [...shared, consumeTreatment(input, ids)], treatment_action_index: shared.length };
}

/**
 * The ClientRequestToken of a plan: its own `provider_commit_id` (D-23).
 *
 * @example
 * await store.transact(plan.actions, commitToken(plan));
 */
export function commitToken(plan: CommitPlan): Uuid4 {
  return plan.ids.provider_commit_id;
}

/**
 * The ledger sort key of a transaction (design §9.3).
 *
 * @example
 * ledgerSortKey(txId); // 'tx#<txId>'
 */
export function ledgerSortKey(providerTransactionId: Uuid4): string {
  return `${LEDGER_SORT_KEY_PREFIX}${providerTransactionId}`;
}

function ledgerTransactionOf(input: CommitPlanInput): LedgerTransaction {
  return {
    provider_transaction_id: input.identities.provider_transaction_id,
    provider_commit_id: input.identities.provider_commit_id,
    provider_call_id: input.provider_call_id,
    attempt_id: input.call.attempt_id,
    provider_request_id: input.call.provider_request_id,
    refund_request_id: input.call.refund_request_id,
    payment_id: input.call.payment_id,
    amount_minor: input.call.amount_minor,
    currency: input.call.currency,
    status: 'SUCCEEDED',
    commit_requested_at: input.commit_requested_at,
  };
}

function consumeTreatment(input: CommitPlanInput, ids: CommitIds): UpdateAction {
  return {
    kind: 'update',
    table: 'control',
    key: { pk: input.partition, sk: TREATMENT_SORT_KEY },
    set: {
      state: 'COMMITTED_WAITING',
      targeted_attempt_id: input.call.attempt_id,
      provider_request_id: input.call.provider_request_id,
      provider_call_id: input.provider_call_id,
      provider_commit_id: ids.provider_commit_id,
      provider_transaction_id: ids.provider_transaction_id,
      commit_event_id: ids.commit_event_id,
    },
    increment: { version: 1 },
    condition: { kind: 'attribute_equals', name: 'state', value: 'ARMED' },
  };
}
