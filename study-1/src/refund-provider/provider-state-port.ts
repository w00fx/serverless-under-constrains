// The provider's narrow view of the durable store (design §5.3 `ProviderStatePort`): strongly
// consistent reads of the control items, the commit transaction, and the conditional treatment
// transitions, each together with its provider journal put in one transaction (BR-RUA-025).
// Its IAM grant is exactly this: control reads and conditional updates, ledger puts inside the
// commit transaction only, experiment-journal puts (design §9.6).

import type { DurableItemStore, StoredItem, WriteOutcome } from '../durable-store/item-store-port.ts';
import { STORE_CODES } from '../durable-store/item-store-port.ts';
import { journalPutAction } from '../event-journal/journal-entry.ts';
import type { PreparedJournalPut } from '../event-journal/journal-writer.ts';
import type { JsonValue, Result, Uuid4 } from '../record-contract/primitives.ts';
import type { TreatmentItem } from '../record-contract/records/group-b/treatment_state_snapshot.ts';
import type { TreatmentState } from '../record-contract/records/group-b/vocabulary.ts';
import type { CommitPlan } from './commit-plan.ts';
import { commitToken } from './commit-plan.ts';
import type { PaymentView, ProviderConfigView } from './control-items.ts';
import {
  CONFIG_SORT_KEY,
  decodeConfigItem,
  decodePaymentItem,
  decodeTreatmentItem,
  paymentSortKey,
  TREATMENT_SORT_KEY,
} from './control-items.ts';
import type { CallPartition } from './provider-partition.ts';

/** Why a control read gave no usable answer: a store error code, or an undecodable item. */
export interface ProviderStateReadFailure {
  readonly code: string;
  readonly detail: string;
}

export type ProviderStateRead<T> = Result<T | undefined, ProviderStateReadFailure>;

/** One conditional treatment transition with the provider event that records it. */
export interface TreatmentTransition {
  readonly partition: string;
  readonly from: TreatmentState;
  readonly to: TreatmentState;
  /** Attributes written besides `state`, such as the event id that records the transition. */
  readonly set: Readonly<Record<string, JsonValue>>;
  readonly event: PreparedJournalPut;
  /** A fresh ClientRequestToken; a transition is never replayed. */
  readonly token: Uuid4;
}

export interface ProviderStatePort {
  loadTrialConfiguration(partition: CallPartition): Promise<ProviderStateRead<ProviderConfigView>>;
  loadPayment(partition: string, paymentId: string): Promise<ProviderStateRead<PaymentView>>;
  loadTreatment(partition: string): Promise<ProviderStateRead<TreatmentItem>>;
  /** TransactWriteItems with ClientRequestToken = `commitToken(plan)` (D-23). */
  commit(plan: CommitPlan): Promise<WriteOutcome>;
  /** The treatment update (condition: `state = from`) and its journal put, atomically. */
  transition(transition: TreatmentTransition): Promise<WriteOutcome>;
}

/**
 * Binds the provider's state port to the durable item store.
 *
 * @example
 * const state = createProviderStatePort(createDynamoDbItemStore(tables, client));
 * const config = await state.loadTrialConfiguration(partition);
 */
export function createProviderStatePort(store: DurableItemStore): ProviderStatePort {
  return {
    loadTrialConfiguration: (partition) =>
      readControl(store, partition.key, CONFIG_SORT_KEY, (item) => decodeConfigItem(item, partition.trial_id)),
    loadPayment: (partition, paymentId) => readControl(store, partition, paymentSortKey(paymentId), decodePaymentItem),
    loadTreatment: (partition) => readControl(store, partition, TREATMENT_SORT_KEY, decodeTreatmentItem),
    commit: (plan) => store.transact(plan.actions, commitToken(plan)),
    transition: (transition) =>
      store.transact(
        [
          {
            kind: 'update',
            table: 'control',
            key: { pk: transition.partition, sk: TREATMENT_SORT_KEY },
            set: { ...transition.set, state: transition.to },
            increment: { version: 1 },
            condition: { kind: 'attribute_equals', name: 'state', value: transition.from },
          },
          journalPutAction('experiment_journal', transition.event),
        ],
        transition.token,
      ),
  };
}

async function readControl<T>(
  store: DurableItemStore,
  pk: string,
  sk: string,
  decode: (item: StoredItem) => Result<T, string>,
): Promise<ProviderStateRead<T>> {
  const read = await store.getConsistent('control', { pk, sk });
  if (!read.ok) {
    return {
      ok: false,
      error: { code: read.error.code, detail: `control read ${pk}/${sk} failed: ${read.error.code}` },
    };
  }
  if (read.value === undefined) {
    return { ok: true, value: undefined };
  }
  const decoded = decode(read.value);
  return decoded.ok ? decoded : { ok: false, error: { code: STORE_CODES.undecodableItem, detail: decoded.error } };
}
