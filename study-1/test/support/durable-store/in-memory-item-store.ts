// In-memory emulator of the DurableItemStore port over DynamoDB semantics (design §12.2).
// It shares request validation, condition vocabulary and cursors with the DynamoDB adapter,
// and reproduces the documented service behavior the adapter relies on:
// - conditional writes return the old item (`ReturnValuesOnConditionCheckFailure: ALL_OLD`);
// - `TransactWriteItems` is all-or-nothing. It evaluates every action and reports the first
//   failed condition before any other cancellation reason, the same precedence that
//   `classifyDynamoError` applies to the service's CancellationReasons. Which reasons AWS
//   reports for such a mix is not documented; sharing the rule keeps fake and adapter agreeing;
// - an update whose resulting item exceeds 400 KB is refused like an ADD on a non-number
//   (`attribute-value-limits.ts`); the request validation already refuses oversized puts;
// - `ClientRequestToken` replays with identical actions succeed without re-applying for 10
//   minutes after completion, and replays with changed actions fail with
//   `IdempotentParameterMismatchException` (F-1). F-1 leaves a replay after a cancelled
//   transaction unspecified, so only applied transactions register their token here;
// - a query page holds at most `pageSize` items and carries a cursor whenever it is full, even
//   when nothing remains, because DynamoDB only proves completeness by an absent
//   `LastEvaluatedKey` ([R-aws] §1.3);
// - streams see one change per modified item and none for a write that changes nothing
//   (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html).
// Fault injection: scripted definitive failures, ambiguous outcomes (applied or not, then a
// lost response), read failures and the page size.
// Known limitation: an ADD whose sum leaves the safe-integer range is stored as the rounded
// double. DynamoDB would store the exact decimal and the adapter's next read would report
// UndecodableItem. The study's counters (`version`, +1 per transition) cannot get there.

import { canonicalJson, structurallyEqual } from '../../../src/record-contract/canonical-json.ts';
import type { JsonValue, Result, WallClock } from '../../../src/record-contract/primitives.ts';
import { STORE_CODES } from '../../../src/durable-store/item-store-port.ts';
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
import { itemSizeViolation } from '../../../src/durable-store/attribute-value-limits.ts';
import { decodePageCursor, encodePageCursor } from '../../../src/durable-store/page-cursor.ts';
import {
  keyViolations,
  partitionKeyViolations,
  validateTransaction,
  validateWriteAction,
} from '../../../src/durable-store/write-action-validation.ts';
import type { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';
import { applyUpdate, compareUtf8, conditionHolds } from './item-semantics.ts';

export const IDEMPOTENCY_WINDOW_MS = 600_000;
export const DEFAULT_PAGE_SIZE = 100;
export const MUTATION_LOG_PORT = 'dynamodb';

export type ScriptedWriteFault =
  | { readonly kind: 'definitive_failure'; readonly code: string }
  | { readonly kind: 'ambiguous'; readonly code: string; readonly applied: boolean };

export interface WriteFaultTarget {
  readonly operation?: 'write' | 'transact';
  readonly table?: TableRole;
}

export interface ReadFaultTarget {
  readonly operation?: 'getConsistent' | 'queryPartitionPage';
  readonly table?: TableRole;
}

/** One stream-visible modification of one item. */
export interface ItemChange {
  readonly table: TableRole;
  readonly event_name: 'INSERT' | 'MODIFY';
  readonly keys: ItemKey;
  readonly new_image: StoredItem;
  readonly old_image?: StoredItem;
}

export interface ItemChangeSource {
  subscribe(table: TableRole, listener: (change: ItemChange) => void): () => void;
}

export interface InMemoryItemStoreOptions {
  readonly clock: WallClock;
  readonly pageSize?: number;
  readonly mutationLog?: RecordingMutationLog;
}

interface QueuedFault<F, T> {
  readonly fault: F;
  readonly target: T;
}

interface Commit {
  readonly table: TableRole;
  readonly item: StoredItem;
  readonly previous: StoredItem | undefined;
}

/**
 * The offline DurableItemStore: DynamoDB item semantics in memory, on an injected clock, with
 * scripted faults and a change feed for `StreamFeed`.
 *
 * @example
 * const store = new InMemoryItemStore({ clock: new VirtualTimeScheduler({ wallEpochMs: 0 }) });
 * store.scriptWriteFault({ kind: 'ambiguous', code: 'TimeoutError', applied: true }, { table: 'ledger' });
 * await store.transact([ledgerPut, journalPut], token); // { kind: 'ambiguous', code: 'TimeoutError' }, yet applied
 */
export class InMemoryItemStore implements DurableItemStore, ItemChangeSource {
  readonly #clock: WallClock;
  readonly #mutationLog: RecordingMutationLog | undefined;
  readonly #tables = new Map<TableRole, Map<string, Map<string, StoredItem>>>();
  readonly #tokens = new Map<string, { readonly request: string; readonly completedAtMs: number }>();
  readonly #writeFaults: QueuedFault<ScriptedWriteFault, WriteFaultTarget>[] = [];
  readonly #readFaults: QueuedFault<string, ReadFaultTarget>[] = [];
  readonly #listeners = new Set<{ readonly table: TableRole; readonly listener: (change: ItemChange) => void }>();
  #pageSize: number;

  constructor(options: InMemoryItemStoreOptions) {
    this.#clock = options.clock;
    this.#mutationLog = options.mutationLog;
    this.#pageSize = DEFAULT_PAGE_SIZE;
    this.setPageSize(options.pageSize ?? DEFAULT_PAGE_SIZE);
  }

  write(action: WriteAction): Promise<WriteOutcome> {
    const key = action.kind === 'put' ? action.item : action.key;
    this.#mutationLog?.record({
      port: MUTATION_LOG_PORT,
      operation: writeOperationName(action),
      target: action.table,
      detail: { pk: key.pk, sk: key.sk },
    });
    if (validateWriteAction(action).length > 0) {
      return Promise.resolve({ kind: 'definitive_failure', code: STORE_CODES.validation });
    }
    const fault = this.#takeWriteFault('write', [action.table]);
    return Promise.resolve(this.#withFault(fault, () => this.#execute([action], 'ValidationException')));
  }

  transact(actions: readonly WriteAction[], clientRequestToken: string): Promise<WriteOutcome> {
    this.#mutationLog?.record({
      port: MUTATION_LOG_PORT,
      operation: 'TransactWriteItems',
      target: [...new Set(actions.map((action) => action.table))].join(','),
      detail: { client_request_token: clientRequestToken, action_count: actions.length },
    });
    if (validateTransaction(actions, clientRequestToken).length > 0) {
      return Promise.resolve({ kind: 'definitive_failure', code: STORE_CODES.validation });
    }
    const fault = this.#takeWriteFault(
      'transact',
      actions.map((action) => action.table),
    );
    return Promise.resolve(this.#withFault(fault, () => this.#executeIdempotent(actions, clientRequestToken)));
  }

  getConsistent(table: TableRole, key: ItemKey): Promise<Result<StoredItem | undefined, StoreReadFailure>> {
    if (keyViolations(key, 'get').length > 0) {
      return Promise.resolve({ ok: false, error: { code: STORE_CODES.validation } });
    }
    const fault = this.#takeReadFault('getConsistent', table);
    if (fault !== undefined) {
      return Promise.resolve({ ok: false, error: { code: fault } });
    }
    return Promise.resolve({ ok: true, value: this.peek(table, key) });
  }

  queryPartitionPage(table: TableRole, pk: string, cursor?: string): Promise<Result<QueryPage, StoreReadFailure>> {
    if (partitionKeyViolations(pk, 'query').length > 0) {
      return Promise.resolve({ ok: false, error: { code: STORE_CODES.validation } });
    }
    const fault = this.#takeReadFault('queryPartitionPage', table);
    if (fault !== undefined) {
      return Promise.resolve({ ok: false, error: { code: fault } });
    }
    const start = cursor === undefined ? undefined : decodePageCursor(cursor, pk);
    if (start?.ok === false) {
      return Promise.resolve({ ok: false, error: { code: STORE_CODES.invalidCursor } });
    }
    const remaining = this.#partition(table, pk).filter(
      (item) => start === undefined || compareUtf8(item.sk, start.value.sk) > 0,
    );
    const items = remaining.slice(0, this.#pageSize).map((item) => structuredClone(item));
    const last = items.at(-1);
    const page: QueryPage =
      items.length === this.#pageSize && last !== undefined
        ? { items, next_cursor: encodePageCursor(last), consistent_read: true }
        : { items, consistent_read: true };
    return Promise.resolve({ ok: true, value: page });
  }

  /** Stores an item directly, as preloaded state: no validation, no log entry, no stream record. */
  seed(table: TableRole, item: StoredItem): void {
    this.#partitionMap(table, item.pk).set(item.sk, structuredClone(item));
  }

  /** The current item under a key, as a copy, or `undefined`. */
  peek(table: TableRole, key: ItemKey): StoredItem | undefined {
    const item = this.#tables.get(table)?.get(key.pk)?.get(key.sk);
    return item === undefined ? undefined : structuredClone(item);
  }

  /** Every item of a table, ordered by partition key then sort key (UTF-8 bytes). */
  itemsIn(table: TableRole): readonly StoredItem[] {
    const partitions = [...(this.#tables.get(table)?.keys() ?? [])].sort(compareUtf8);
    return partitions.flatMap((pk) => this.#partition(table, pk)).map((item) => structuredClone(item));
  }

  /** Sets the maximum number of items per query page (a count stand-in for the 1 MB limit). */
  setPageSize(pageSize: number): void {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new RangeError(`page size ${String(pageSize)}; expected a positive safe integer`);
    }
    this.#pageSize = pageSize;
  }

  /** The next write matching `target` (any write when omitted) fails with `fault`. */
  scriptWriteFault(fault: ScriptedWriteFault, target: WriteFaultTarget = {}): void {
    this.#writeFaults.push({ fault, target });
  }

  /** The next read matching `target` (any read when omitted) fails with `code`. */
  scriptReadFault(code: string, target: ReadFaultTarget = {}): void {
    this.#readFaults.push({ fault: code, target });
  }

  pendingFaultCount(): number {
    return this.#writeFaults.length + this.#readFaults.length;
  }

  subscribe(table: TableRole, listener: (change: ItemChange) => void): () => void {
    const entry = { table, listener };
    this.#listeners.add(entry);
    return () => this.#listeners.delete(entry);
  }

  #withFault(fault: ScriptedWriteFault | undefined, run: () => WriteOutcome): WriteOutcome {
    if (fault === undefined) {
      return run();
    }
    if (fault.kind === 'ambiguous' && fault.applied) {
      run();
    }
    return fault.kind === 'ambiguous' ? { kind: 'ambiguous', code: fault.code } : fault;
  }

  #executeIdempotent(actions: readonly WriteAction[], token: string): WriteOutcome {
    const nowMs = this.#clock.now().getTime();
    for (const [knownToken, entry] of this.#tokens) {
      if (nowMs - entry.completedAtMs >= IDEMPOTENCY_WINDOW_MS) {
        this.#tokens.delete(knownToken);
      }
    }
    const request = canonicalJson(actions as unknown as JsonValue);
    const known = this.#tokens.get(token);
    if (known !== undefined) {
      return known.request === request
        ? { kind: 'applied' }
        : { kind: 'definitive_failure', code: 'IdempotentParameterMismatchException' };
    }
    const outcome = this.#execute(actions, 'ValidationError');
    if (outcome.kind === 'applied') {
      this.#tokens.set(token, { request, completedAtMs: nowMs });
    }
    return outcome;
  }

  // `typeErrorCode` is what DynamoDB reports for an ADD on a non-number or an update past the
  // item size limit: a single UpdateItem fails with ValidationException, a transaction is
  // cancelled with reason ValidationError.
  #execute(actions: readonly WriteAction[], typeErrorCode: string): WriteOutcome {
    const commits: Commit[] = [];
    let refused = false;
    for (const [index, action] of actions.entries()) {
      const key = action.kind === 'put' ? action.item : action.key;
      const previous = this.peek(action.table, key);
      if (action.condition !== undefined && !conditionHolds(action.condition, previous)) {
        return previous === undefined
          ? { kind: 'condition_failed', failed_action_index: index }
          : { kind: 'condition_failed', failed_action_index: index, existing: previous };
      }
      const next = nextImage(action, previous);
      refused ||= !next.ok;
      if (next.ok && next.value !== undefined) {
        commits.push({ table: action.table, item: next.value, previous });
      }
    }
    if (refused) {
      return { kind: 'definitive_failure', code: typeErrorCode };
    }
    commits.forEach((commit) => {
      this.#commit(commit);
    });
    return { kind: 'applied' };
  }

  #commit(commit: Commit): void {
    if (commit.previous !== undefined && structurallyEqual(commit.previous, commit.item)) {
      return;
    }
    this.seed(commit.table, commit.item);
    const change: ItemChange =
      commit.previous === undefined
        ? { table: commit.table, event_name: 'INSERT', keys: keyOf(commit.item), new_image: commit.item }
        : {
            table: commit.table,
            event_name: 'MODIFY',
            keys: keyOf(commit.item),
            new_image: commit.item,
            old_image: commit.previous,
          };
    for (const entry of [...this.#listeners].filter((candidate) => candidate.table === commit.table)) {
      entry.listener(structuredClone(change));
    }
  }

  #takeWriteFault(operation: 'write' | 'transact', tables: readonly TableRole[]): ScriptedWriteFault | undefined {
    const index = this.#writeFaults.findIndex(
      ({ target }) =>
        (target.operation === undefined || target.operation === operation) &&
        (target.table === undefined || tables.includes(target.table)),
    );
    return index === -1 ? undefined : this.#writeFaults.splice(index, 1)[0]?.fault;
  }

  #takeReadFault(operation: 'getConsistent' | 'queryPartitionPage', table: TableRole): string | undefined {
    const index = this.#readFaults.findIndex(
      ({ target }) =>
        (target.operation === undefined || target.operation === operation) &&
        (target.table === undefined || target.table === table),
    );
    return index === -1 ? undefined : this.#readFaults.splice(index, 1)[0]?.fault;
  }

  #partition(table: TableRole, pk: string): readonly StoredItem[] {
    const items = [...(this.#tables.get(table)?.get(pk)?.values() ?? [])];
    return items.sort((a, b) => compareUtf8(a.sk, b.sk));
  }

  #partitionMap(table: TableRole, pk: string): Map<string, StoredItem> {
    const partitions = this.#tables.get(table) ?? new Map<string, Map<string, StoredItem>>();
    this.#tables.set(table, partitions);
    const items = partitions.get(pk) ?? new Map<string, StoredItem>();
    partitions.set(pk, items);
    return items;
  }
}

function nextImage(action: WriteAction, previous: StoredItem | undefined): Result<StoredItem | undefined, string> {
  switch (action.kind) {
    case 'put':
      return { ok: true, value: structuredClone(action.item) };
    case 'update': {
      const updated = applyUpdate(previous, action);
      const oversized = updated.ok ? itemSizeViolation(updated.value, 'updated item') : undefined;
      return oversized === undefined ? updated : { ok: false, error: oversized };
    }
    case 'condition_check':
      return { ok: true, value: undefined };
  }
}

function writeOperationName(action: WriteAction): string {
  switch (action.kind) {
    case 'put':
      return 'PutItem';
    case 'update':
      return 'UpdateItem';
    case 'condition_check':
      return 'TransactWriteItems';
  }
}

function keyOf(item: StoredItem): ItemKey {
  return { pk: item.pk, sk: item.sk };
}
