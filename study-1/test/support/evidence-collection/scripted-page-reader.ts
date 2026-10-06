// A named fake of the collector's store reads (`CollectorStoreReader`, design §9.3) for the
// behaviors the in-memory store never produces: a store that answers a page with a cursor it has
// already returned (a pagination loop) or with items under hostile keys. Pages are scripted per
// table and partition and served in order; point reads come from a fixed item map.

import type {
  ItemKey,
  QueryPage,
  StoredItem,
  StoreReadFailure,
  TableRole,
} from '../../../src/durable-store/item-store-port.ts';
import type { Result } from '../../../src/record-contract/primitives.ts';
import type { CollectorStoreReader } from '../../../src/evidence-collection/collected-records.ts';

/**
 * Scripted query pages and point reads.
 *
 * @example
 * const reader = new ScriptedPageReader();
 * reader.scriptPage('ledger', pk, { items: [tx1], next_cursor: 'c1', consistent_read: true });
 * reader.scriptPage('ledger', pk, { items: [tx2], next_cursor: 'c1', consistent_read: true }); // repeats c1
 */
export class ScriptedPageReader implements CollectorStoreReader {
  readonly #pages = new Map<string, Result<QueryPage, StoreReadFailure>[]>();
  readonly #items = new Map<string, StoredItem>();
  readonly #cursors: (string | undefined)[] = [];

  /** Queues the next page of a partition. */
  scriptPage(table: TableRole, pk: string, page: QueryPage): void {
    this.#queue(table, pk).push({ ok: true, value: page });
  }

  /** Queues a failed page read of a partition. */
  scriptPageFailure(table: TableRole, pk: string, code: string): void {
    this.#queue(table, pk).push({ ok: false, error: { code } });
  }

  /** Stores an item for point reads. */
  putItem(table: TableRole, item: StoredItem): void {
    this.#items.set(itemAddress(table, item), item);
  }

  /** The cursor each page query was asked with, in order. */
  cursors(): readonly (string | undefined)[] {
    return [...this.#cursors];
  }

  getConsistent(table: TableRole, key: ItemKey): Promise<Result<StoredItem | undefined, StoreReadFailure>> {
    return Promise.resolve({ ok: true, value: this.#items.get(itemAddress(table, key)) });
  }

  queryPartitionPage(table: TableRole, pk: string, cursor?: string): Promise<Result<QueryPage, StoreReadFailure>> {
    this.#cursors.push(cursor);
    const next = this.#queue(table, pk).shift();
    return Promise.resolve(next ?? { ok: true, value: { items: [], consistent_read: true } });
  }

  #queue(table: TableRole, pk: string): Result<QueryPage, StoreReadFailure>[] {
    const address = `${table}\u0000${pk}`;
    const queued = this.#pages.get(address) ?? [];
    this.#pages.set(address, queued);
    return queued;
  }
}

function itemAddress(table: TableRole, key: ItemKey): string {
  return `${table}\u0000${key.pk}\u0000${key.sk}`;
}
