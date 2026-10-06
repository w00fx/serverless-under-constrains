// A DurableItemStore decorator whose consistent read hands back one scripted item exactly as
// given, without the structured clone the in-memory store applies. The Owner amendment A-05
// hostile shapes then reach the step-5 release decision intact: an item whose prototype carries
// `state` and `version`, or a member nested 100,000 levels deep. Writes, transactions and queries
// pass through to the wrapped store, so a release that should not happen stays observable there.

import type {
  DurableItemStore,
  ItemKey,
  QueryPage,
  StoredItem,
  StoreReadFailure,
  TableRole,
  WriteAction,
  WriteOutcome,
} from '../../../src/durable-store/item-store-port.ts';
import type { Result, Uuid4 } from '../../../src/record-contract/primitives.ts';

/**
 * Wraps a store and answers every consistent read with one scripted item, uncloned.
 *
 * @example
 * const hostile = new VerbatimReadItemStore(store, Object.create({ state: 'ARMED' }) as StoredItem);
 * await new ControlTableBarrierRelease(hostile).requestSafetyRelease(partition); // failed, no write
 */
export class VerbatimReadItemStore implements DurableItemStore {
  readonly #inner: DurableItemStore;
  readonly #item: StoredItem;
  #writes = 0;

  constructor(inner: DurableItemStore, item: StoredItem) {
    this.#inner = inner;
    this.#item = item;
  }

  /** Writes and transactions received, so a test can prove the release never wrote. */
  writeCount(): number {
    return this.#writes;
  }

  write(action: WriteAction): Promise<WriteOutcome> {
    this.#writes += 1;
    return this.#inner.write(action);
  }

  transact(actions: readonly WriteAction[], clientRequestToken: Uuid4): Promise<WriteOutcome> {
    this.#writes += 1;
    return this.#inner.transact(actions, clientRequestToken);
  }

  getConsistent(_table: TableRole, _key: ItemKey): Promise<Result<StoredItem | undefined, StoreReadFailure>> {
    return Promise.resolve({ ok: true, value: this.#item });
  }

  queryPartitionPage(table: TableRole, pk: string, cursor?: string): Promise<Result<QueryPage, StoreReadFailure>> {
    return this.#inner.queryPartitionPage(table, pk, cursor);
  }
}
