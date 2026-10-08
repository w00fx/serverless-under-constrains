// A DurableItemStore decorator that lets another writer act between cleanup's read and its
// conditional write (the step-5 safety release races the provider and the controller,
// BR-RUA-025). After the Nth consistent read it runs a scripted mutation on the wrapped store,
// then returns the read as it was before that mutation.

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

type Interleaving = (store: DurableItemStore) => Promise<void>;

/**
 * Wraps a store and runs a scripted concurrent mutation right after chosen reads.
 *
 * @example
 * const racing = new InterleavingItemStore(store);
 * racing.afterRead(1, async (inner) => { await inner.write(providerTransition); });
 * await racing.getConsistent('control', key); // the item before the provider's transition
 */
export class InterleavingItemStore implements DurableItemStore {
  readonly #inner: DurableItemStore;
  readonly #interleavings = new Map<number, Interleaving>();
  #reads = 0;

  constructor(inner: DurableItemStore) {
    this.#inner = inner;
  }

  /** Runs `mutation` on the wrapped store right after the `readNumber`-th consistent read (1-based). */
  afterRead(readNumber: number, mutation: Interleaving): void {
    this.#interleavings.set(readNumber, mutation);
  }

  readCount(): number {
    return this.#reads;
  }

  write(action: WriteAction): Promise<WriteOutcome> {
    return this.#inner.write(action);
  }

  transact(actions: readonly WriteAction[], clientRequestToken: Uuid4): Promise<WriteOutcome> {
    return this.#inner.transact(actions, clientRequestToken);
  }

  async getConsistent(table: TableRole, key: ItemKey): Promise<Result<StoredItem | undefined, StoreReadFailure>> {
    const read = await this.#inner.getConsistent(table, key);
    this.#reads += 1;
    const interleaving = this.#interleavings.get(this.#reads);
    if (interleaving !== undefined) {
      await interleaving(this.#inner);
    }
    return read;
  }

  queryPartitionPage(table: TableRole, pk: string, cursor?: string): Promise<Result<QueryPage, StoreReadFailure>> {
    return this.#inner.queryPartitionPage(table, pk, cursor);
  }
}
