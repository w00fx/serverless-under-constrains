// Shared fixtures of the InMemoryItemStore conformance tests: one store on virtual time with a
// mutation log, and the treatment and ledger actions the provider commit uses (design §9.3).

import type { StoredItem, TableRole, WriteAction, WriteOutcome } from '../../../src/durable-store/item-store-port.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';
import { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';
import { InMemoryItemStore } from './in-memory-item-store.ts';

export const TOKEN = '11111111-2222-4333-8444-555555555555' as Uuid4;
export const OTHER_TOKEN = '11111111-2222-4333-8444-666666666666' as Uuid4;
export const PK = 'run#trial';

export interface StoreHarness {
  readonly store: InMemoryItemStore;
  readonly time: VirtualTimeScheduler;
  readonly log: RecordingMutationLog;
}

/**
 * A fresh store at 2026-10-05T00:00:00.000Z virtual time with a mutation log, optionally with a
 * page size.
 *
 * @example
 * const { store, time, log } = storeHarness(2);
 * await store.write(putAction('ledger', { pk: PK, sk: 'tx#1' }));
 */
export function storeHarness(pageSize?: number): StoreHarness {
  const time = new VirtualTimeScheduler({ wallEpochMs: Date.UTC(2026, 9, 5) });
  const log = new RecordingMutationLog();
  const store =
    pageSize === undefined
      ? new InMemoryItemStore({ clock: time, mutationLog: log })
      : new InMemoryItemStore({ clock: time, mutationLog: log, pageSize });
  return { store, time, log };
}

/**
 * A put action, conditional when `condition` is given.
 *
 * @example
 * putAction('ledger', { pk: PK, sk: 'tx#1', amount_minor: 10000 }, { kind: 'item_absent' });
 */
export function putAction(table: TableRole, item: StoredItem, condition?: WriteAction['condition']): WriteAction {
  return condition === undefined ? { kind: 'put', table, item } : { kind: 'put', table, item, condition };
}

/**
 * The outcome of a single write whose condition failed on `existing` (ALL_OLD).
 *
 * @example
 * assert.deepEqual(await store.write(putAction('control', item, { kind: 'item_absent' })), failedOn(item));
 */
export function failedOn(existing: StoredItem): WriteOutcome {
  return { kind: 'condition_failed', failed_action_index: 0, existing };
}

export const ARMED: StoredItem = { pk: PK, sk: 'treatment', state: 'ARMED', version: 1 };

export const COMMIT_TREATMENT: WriteAction = {
  kind: 'update',
  table: 'control',
  key: { pk: PK, sk: 'treatment' },
  set: { state: 'COMMITTED_WAITING' },
  increment: { version: 1 },
  condition: { kind: 'attribute_equals', name: 'state', value: 'ARMED' },
};
