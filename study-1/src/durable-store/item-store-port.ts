// The durable item store port (design §5.3 `durable-store/`, WP-04): BR-RUA-053's "durable
// storage capable of atomic multi-record transitions and strongly consistent trial-scoped
// reads", as one narrow typed port. Production binds it to DynamoDB base tables
// (`aws/dynamodb-item-store.ts`); offline tests bind it to the `InMemoryItemStore` fake.
//
// Every write returns a closed outcome union instead of throwing, because callers decide what
// a definitive versus an ambiguous result means for them (BR-RUA-033: a definitive failure is
// retried with identical content; an ambiguous one stops the writing instance).

import type { JsonValue, Result, Uuid4 } from '../record-contract/primitives.ts';

export const TABLE_ROLES = [
  'ledger',
  'experiment_journal',
  'caller_journal',
  'control',
  'trial_registry',
  'coordination',
] as const;
/** The logical tables of design §9.3 plus the baseline coordination table (§9.1). */
export type TableRole = (typeof TABLE_ROLES)[number];

/** Base-table primary key: string partition key `pk` and string sort key `sk` (design §9.3). */
export interface ItemKey {
  readonly pk: string;
  readonly sk: string;
}

/** A stored item: its key plus JSON-valued attributes. */
export type StoredItem = Readonly<Record<string, JsonValue>> & ItemKey;

/** Attribute names that form the primary key and can never be updated (DynamoDB rejects it). */
export const KEY_ATTRIBUTES = ['pk', 'sk'] as const;

/**
 * A write precondition, evaluated against the item's state before the write.
 * - `item_absent`: no item exists under the key.
 * - `attribute_equals`: the attribute exists with exactly this JSON type and value.
 * - `attribute_in`: the attribute exists and is one of these strings (1 to 100 values).
 * - `all`: every nested condition holds (at least one condition).
 */
export type Condition =
  | { readonly kind: 'item_absent' }
  | { readonly kind: 'attribute_equals'; readonly name: string; readonly value: string | number | boolean }
  | { readonly kind: 'attribute_in'; readonly name: string; readonly values: readonly string[] }
  | { readonly kind: 'all'; readonly conditions: readonly Condition[] };

export interface PutAction {
  readonly kind: 'put';
  readonly table: TableRole;
  readonly item: StoredItem;
  readonly condition?: Condition;
}

/**
 * Sets attributes and adds numeric increments. Like DynamoDB `UpdateItem`, an update whose
 * condition admits a missing item (`item_absent`) creates the item; an increment of a
 * missing attribute starts from zero (`ADD`).
 */
export interface UpdateAction {
  readonly kind: 'update';
  readonly table: TableRole;
  readonly key: ItemKey;
  readonly set: Readonly<Record<string, JsonValue>>;
  readonly increment?: Readonly<Record<string, number>>;
  readonly condition: Condition;
}

/** Verifies a condition without changing the item (a transaction member or a single check). */
export interface ConditionCheckAction {
  readonly kind: 'condition_check';
  readonly table: TableRole;
  readonly key: ItemKey;
  readonly condition: Condition;
}

export type WriteAction = PutAction | UpdateAction | ConditionCheckAction;

/**
 * - `applied`: every action took effect.
 * - `condition_failed`: nothing took effect; `failed_action_index` is the first action whose
 *   condition did not hold and `existing` is that item as it was (DynamoDB `ALL_OLD`), absent
 *   when the item did not exist.
 * - `definitive_failure`: the service rejected the request; nothing took effect.
 * - `ambiguous`: network, server fault or timeout; the write may or may not have taken effect.
 */
export type WriteOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'condition_failed'; readonly failed_action_index: number; readonly existing?: StoredItem }
  | { readonly kind: 'definitive_failure'; readonly code: string }
  | { readonly kind: 'ambiguous'; readonly code: string };

/** One strongly consistent page of a partition, ascending by sort key. */
export interface QueryPage {
  readonly items: readonly StoredItem[];
  /** Present when the read stopped at a page boundary; absence is the only proof of completeness. */
  readonly next_cursor?: string;
  readonly consistent_read: true;
}

/** Why a read did not return data (an SDK error name or a local decoding code). */
export interface StoreReadFailure {
  readonly code: string;
}

export interface DurableItemStore {
  /** One conditional write (a `condition_check` alone verifies without writing). */
  write(action: WriteAction): Promise<WriteOutcome>;
  /**
   * 1 to 100 actions on distinct items, applied atomically. `clientRequestToken` makes a
   * replay with identical actions idempotent for 10 minutes; a replay with changed actions
   * fails with `IdempotentParameterMismatchException` (F-1).
   */
  transact(actions: readonly WriteAction[], clientRequestToken: Uuid4): Promise<WriteOutcome>;
  /** Strongly consistent point read; `undefined` when no item exists under the key. */
  getConsistent(table: TableRole, key: ItemKey): Promise<Result<StoredItem | undefined, StoreReadFailure>>;
  /** One strongly consistent page of the partition `pk`, continued from `cursor`. */
  queryPartitionPage(table: TableRole, pk: string, cursor?: string): Promise<Result<QueryPage, StoreReadFailure>>;
}

/** Local codes shared by every implementation of the port, so callers see one vocabulary. */
export const STORE_CODES = {
  validation: 'ValidationException',
  tableNotConfigured: 'TableNotConfigured',
  invalidCursor: 'InvalidCursor',
  undecodableItem: 'UndecodableItem',
} as const;
