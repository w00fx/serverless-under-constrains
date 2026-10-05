// The controller's narrow view of the durable store (design §9.6 controller row): strongly
// consistent GetItem of the control `config` and `treatment` items, and the one conditional
// UpdateItem it may make, `COMMITTED_WAITING -> TIMEOUT_SIGNALLED`, written together with its
// `timeout_signal_recorded` put in one transaction (BR-RUA-025).

import type { DurableItemStore, StoredItem, WriteOutcome } from '../durable-store/item-store-port.ts';
import { STORE_CODES } from '../durable-store/item-store-port.ts';
import { journalPutAction } from '../event-journal/journal-entry.ts';
import type { PreparedJournalPut } from '../event-journal/journal-writer.ts';
import type { Result, Uuid4 } from '../record-contract/primitives.ts';
import type { ControllerConfigView, ControllerTreatment } from './controller-control-items.ts';
import {
  CONFIG_SORT_KEY,
  decodeControllerConfig,
  decodeControllerTreatment,
  TREATMENT_SORT_KEY,
} from './controller-control-items.ts';
import type { ExperimentPartition } from './controller-partition.ts';

/** Why a control read gave no usable answer: a store error code, or an undecodable item. */
export interface ControllerReadFailure {
  readonly code: string;
  readonly detail: string;
}

export type ControllerStateRead<T> = Result<T | undefined, ControllerReadFailure>;

/** The signal transition of one partition, with the prepared signal record. */
export interface SignalTransition {
  readonly partition: string;
  /** The targeted attempt the condition re-checks. */
  readonly attempt_id: Uuid4;
  readonly caller_timeout_event_id: Uuid4;
  readonly event: PreparedJournalPut;
  /** A fresh ClientRequestToken; a signal transaction is never replayed. */
  readonly token: Uuid4;
}

export interface ControllerStatePort {
  loadConfiguration(partition: ExperimentPartition): Promise<ControllerStateRead<ControllerConfigView>>;
  loadTreatment(partition: ExperimentPartition): Promise<ControllerStateRead<ControllerTreatment>>;
  /** Condition: `state = COMMITTED_WAITING` and `targeted_attempt_id = attempt_id` (design §9.11). */
  signal(transition: SignalTransition): Promise<WriteOutcome>;
}

/**
 * Binds the controller's state port to the durable item store.
 *
 * @example
 * const state = createControllerStatePort(createDynamoDbItemStore(tables, client));
 * const treatment = await state.loadTreatment(partition);
 */
export function createControllerStatePort(store: DurableItemStore): ControllerStatePort {
  return {
    loadConfiguration: (partition) =>
      readControl(store, partition.key, CONFIG_SORT_KEY, (item) => decodeControllerConfig(item, partition)),
    loadTreatment: (partition) => readControl(store, partition.key, TREATMENT_SORT_KEY, decodeControllerTreatment),
    signal: (transition) =>
      store.transact(
        [
          {
            kind: 'update',
            table: 'control',
            key: { pk: transition.partition, sk: TREATMENT_SORT_KEY },
            set: {
              state: 'TIMEOUT_SIGNALLED',
              signal_event_id: transition.event.event.event_id,
              signal_caller_event_id: transition.caller_timeout_event_id,
            },
            increment: { version: 1 },
            condition: {
              kind: 'all',
              conditions: [
                { kind: 'attribute_equals', name: 'state', value: 'COMMITTED_WAITING' },
                { kind: 'attribute_equals', name: 'targeted_attempt_id', value: transition.attempt_id },
              ],
            },
          },
          journalPutAction('experiment_journal', transition.event),
        ],
        transition.token,
      ),
  };
}

/**
 * Decodes the `ALL_OLD` treatment item a failed signal condition returned, so the controller
 * can re-decide on it (design §9.11). An absent item decodes to `undefined`.
 *
 * @example
 * decodeTreatmentAfterConflict(outcome.existing); // { ok: true, value: { state: 'SAFETY_RELEASED' } }
 */
export function decodeTreatmentAfterConflict(
  existing: StoredItem | undefined,
): Result<ControllerTreatment | undefined, ControllerReadFailure> {
  return existing === undefined ? { ok: true, value: undefined } : decodeOrFail(existing, decodeControllerTreatment);
}

async function readControl<T>(
  store: DurableItemStore,
  pk: string,
  sk: string,
  decode: (item: StoredItem) => Result<T, string>,
): Promise<ControllerStateRead<T>> {
  const read = await store.getConsistent('control', { pk, sk });
  if (!read.ok) {
    return {
      ok: false,
      error: { code: read.error.code, detail: `control read ${pk}/${sk} failed: ${read.error.code}` },
    };
  }
  return read.value === undefined ? { ok: true, value: undefined } : decodeOrFail(read.value, decode);
}

function decodeOrFail<T>(
  item: StoredItem,
  decode: (item: StoredItem) => Result<T, string>,
): Result<T, ControllerReadFailure> {
  const decoded = decode(item);
  return decoded.ok ? decoded : { ok: false, error: { code: STORE_CODES.undecodableItem, detail: decoded.error } };
}
