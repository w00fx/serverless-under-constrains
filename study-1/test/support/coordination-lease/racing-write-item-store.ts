// A DurableItemStore decorator for lease races: it records every single-item write in call
// order and, after the Nth one, lets another writer act on the wrapped store before the
// outcome returns. A competing owner can thereby take a released lease between the two puts
// of an acquisition (the second put must then fail on the winner's item, BR-RUA-045).

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

type CompetingWrite = (store: DurableItemStore) => Promise<void>;

/**
 * Wraps a store, records its writes and runs a scripted competing write after a chosen one.
 *
 * @example
 * const racing = new RacingWriteItemStore(store);
 * racing.afterWrite(1, async (inner) => { await inner.write(winnerPut); });
 * await createDurableLeaseStore(racing).acquire(owner, at); // the second put fails on the winner
 * racing.writes().length; // 2
 */
export class RacingWriteItemStore implements DurableItemStore {
  readonly #inner: DurableItemStore;
  readonly #competitors = new Map<number, CompetingWrite>();
  readonly #writes: WriteAction[] = [];

  constructor(inner: DurableItemStore) {
    this.#inner = inner;
  }

  /** Runs `competitor` on the wrapped store right after the `writeNumber`-th write (1-based). */
  afterWrite(writeNumber: number, competitor: CompetingWrite): void {
    this.#competitors.set(writeNumber, competitor);
  }

  /** Every single-item write passed through, in call order. */
  writes(): readonly WriteAction[] {
    return [...this.#writes];
  }

  async write(action: WriteAction): Promise<WriteOutcome> {
    const outcome = await this.#inner.write(action);
    this.#writes.push(action);
    const competitor = this.#competitors.get(this.#writes.length);
    if (competitor !== undefined) {
      await competitor(this.#inner);
    }
    return outcome;
  }

  transact(actions: readonly WriteAction[], clientRequestToken: Uuid4): Promise<WriteOutcome> {
    return this.#inner.transact(actions, clientRequestToken);
  }

  getConsistent(table: TableRole, key: ItemKey): Promise<Result<StoredItem | undefined, StoreReadFailure>> {
    return this.#inner.getConsistent(table, key);
  }

  queryPartitionPage(table: TableRole, pk: string, cursor?: string): Promise<Result<QueryPage, StoreReadFailure>> {
    return this.#inner.queryPartitionPage(table, pk, cursor);
  }
}
