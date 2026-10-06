// The coordination-store emulation of AC-RUA-023 and AC-RUA-033 (design §12.2 `FakeLeaseStore`):
// the production lease store adapter (`createDurableLeaseStore`) over an `InMemoryItemStore`
// holding the baseline `coordination` table, so every conditional write, ALL_OLD image and
// consistent read follows the emulated DynamoDB semantics ([R-aws] §1.2). The table has no TTL,
// like the deployed one: an item whose `expires_at` lies in the past stays and stays held.
//
// Fault injection:
// - `failNextWrites(count, fault)`: the next `count` lease writes fail definitively, or
//   ambiguously with or without effect (heartbeat failure scripts);
// - `failNextReads(count, code)`: the next `count` consistent reads fail;
// - `answerNextWrite(outcome)`: the next lease write returns `outcome` without reaching the
//   store, for outcomes the emulator cannot produce (a failed condition whose ALL_OLD image the
//   store could not return);
// - `holdNextWrite()` / `releaseHeldWrite()`: the next lease write waits until released, so a
//   test can let virtual time pass while a heartbeat is in flight (a slow write that completes
//   after the stale boundary) or start another operation meanwhile;
// - `seed(item)` / `takeOverBy(owner, at)`: preload any item, or a foreign holder (a foreign
//   takeover, which no conditional write of this owner could have made);
// - `deleteLeaseItemAsTtl()`: the item disappears the way a TTL service deletion removes it
//   (asynchronously, without any release write of the owner). Scripted faults not consumed yet
//   are discarded with the old table.

import type { ItemKey, StoredItem, WriteOutcome } from '../../../src/durable-store/item-store-port.ts';
import { createDurableLeaseStore } from '../../../src/coordination-lease/durable-lease-store.ts';
import type { LeaseItem, LeaseOwner } from '../../../src/coordination-lease/lease-item.ts';
import { LEASE_ITEM_KEY, acquiredLeaseItem, toStoredItem } from '../../../src/coordination-lease/lease-item.ts';
import type { LeaseReadFailure, LeaseStorePort } from '../../../src/coordination-lease/lease-store-port.ts';
import type { Result, UtcMillis, WallClock } from '../../../src/record-contract/primitives.ts';
import type { ScriptedWriteFault } from '../durable-store/in-memory-item-store.ts';
import { InMemoryItemStore } from '../durable-store/in-memory-item-store.ts';
import type { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';

const TABLE = 'coordination';

export interface FakeLeaseStoreOptions {
  readonly clock: WallClock;
  readonly mutationLog?: RecordingMutationLog;
}

/**
 * The lease store port over the in-memory coordination table, with scripted faults.
 *
 * @example
 * const store = new FakeLeaseStore({ clock: time });
 * store.failNextWrites(1, { kind: 'definitive_failure', code: 'ProvisionedThroughputExceededException' });
 * await store.heartbeat(owner, 1, at); // { kind: 'definitive_failure', … }
 */
export class FakeLeaseStore implements LeaseStorePort {
  readonly #options: FakeLeaseStoreOptions;
  readonly #answers: WriteOutcome[] = [];
  #items: InMemoryItemStore;
  #inner: LeaseStorePort;
  #holdNext = false;
  #releaseHeld: (() => void) | undefined;

  constructor(options: FakeLeaseStoreOptions) {
    this.#options = options;
    this.#items = this.#newTable();
    this.#inner = createDurableLeaseStore(this.#items);
  }

  acquire(owner: LeaseOwner, at: UtcMillis): Promise<WriteOutcome> {
    return this.#write(() => this.#inner.acquire(owner, at));
  }

  heartbeat(owner: LeaseOwner, expectedVersion: number, at: UtcMillis): Promise<WriteOutcome> {
    return this.#write(() => this.#inner.heartbeat(owner, expectedVersion, at));
  }

  release(owner: LeaseOwner, expectedVersion: number, at: UtcMillis): Promise<WriteOutcome> {
    return this.#write(() => this.#inner.release(owner, expectedVersion, at));
  }

  markRecoveryRequired(owner: LeaseOwner, expectedVersion: number, at: UtcMillis): Promise<WriteOutcome> {
    return this.#write(() => this.#inner.markRecoveryRequired(owner, expectedVersion, at));
  }

  read(): Promise<Result<LeaseItem | undefined, LeaseReadFailure>> {
    return this.#inner.read();
  }

  /** The next `count` lease writes fail with `fault` (an acquisition may take two writes). */
  failNextWrites(count: number, fault: ScriptedWriteFault): void {
    for (let index = 0; index < count; index += 1) {
      this.#items.scriptWriteFault(fault, { operation: 'write', table: TABLE });
    }
  }

  /** The next `count` consistent reads fail with `code`. */
  failNextReads(count: number, code: string): void {
    for (let index = 0; index < count; index += 1) {
      this.#items.scriptReadFault(code, { operation: 'getConsistent', table: TABLE });
    }
  }

  /** The next lease write returns `outcome` and leaves the table untouched. */
  answerNextWrite(outcome: WriteOutcome): void {
    this.#answers.push(outcome);
  }

  /** The next lease write waits until `releaseHeldWrite()`. */
  holdNextWrite(): void {
    this.#holdNext = true;
  }

  /** Whether a lease write is waiting for `releaseHeldWrite()`. */
  isWriteHeld(): boolean {
    return this.#releaseHeld !== undefined;
  }

  /** Lets the held write proceed. Throws an Error when no write is waiting. */
  releaseHeldWrite(): void {
    const release = this.#releaseHeld;
    if (release === undefined) {
      throw new Error('releaseHeldWrite() with no write waiting; expected holdNextWrite() and a lease write in flight');
    }
    this.#releaseHeld = undefined;
    release();
  }

  /** Stores any item under the lease key (or another key), bypassing every condition. */
  seed(item: StoredItem): void {
    this.#items.seed(TABLE, item);
  }

  /** Another owner now holds the lease at `version`, without any write of this owner. */
  takeOverBy(owner: LeaseOwner, at: UtcMillis, version: number): void {
    this.seed(toStoredItem({ ...acquiredLeaseItem(owner, at), lease_version: version }));
  }

  /** The lease item disappears, as a TTL deletion would remove it; nothing released it. */
  deleteLeaseItemAsTtl(): void {
    const kept = this.#items
      .itemsIn(TABLE)
      .filter((item) => item.pk !== LEASE_ITEM_KEY.pk || item.sk !== LEASE_ITEM_KEY.sk);
    this.#items = this.#newTable();
    this.#inner = createDurableLeaseStore(this.#items);
    for (const item of kept) {
      this.#items.seed(TABLE, item);
    }
  }

  /** The stored lease item (or the item under `key`) as it is now, or `undefined`. */
  current(key: ItemKey = LEASE_ITEM_KEY): StoredItem | undefined {
    return this.#items.peek(TABLE, key);
  }

  /** Scripted faults, answers and holds not consumed yet. */
  pendingScriptCount(): number {
    return this.#items.pendingFaultCount() + this.#answers.length + (this.#holdNext ? 1 : 0);
  }

  async #write(perform: () => Promise<WriteOutcome>): Promise<WriteOutcome> {
    if (this.#holdNext) {
      this.#holdNext = false;
      await new Promise<void>((resolve) => {
        this.#releaseHeld = resolve;
      });
    }
    return this.#answers.shift() ?? perform();
  }

  #newTable(): InMemoryItemStore {
    const { clock, mutationLog } = this.#options;
    return new InMemoryItemStore(mutationLog === undefined ? { clock } : { clock, mutationLog });
  }
}
