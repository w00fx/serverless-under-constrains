// One event ready to persist: the event, its item key and the stored item (the key plus the
// event's attributes). Durable journals store the item in a journal table; file journals
// write the event alone as one JSONL line.

import type { ItemKey, PutAction, StoredItem, TableRole } from '../durable-store/item-store-port.ts';
import { structurallyEqual } from '../record-contract/canonical-json.ts';
import type { JournalEvent } from './journal-event.ts';

/** The tables that hold journal events (design §9.3). */
export type JournalTableRole = Extract<TableRole, 'caller_journal' | 'experiment_journal'>;

export interface JournalEntry {
  readonly key: ItemKey;
  readonly event: JournalEvent;
  readonly item: StoredItem;
}

/**
 * Pairs an event with its key.
 *
 * @example
 * toJournalEntry(journalItemKey(scope, source, instance, 1), event).item.pk; // the partition key
 */
export function toJournalEntry(key: ItemKey, event: JournalEvent): JournalEntry {
  // An event is a JSON object, but its record interfaces carry no index signature, so it does
  // not widen to StoredItem on its own. The item is exactly the event plus its key, checked for
  // every event record type in test/integration/event-journal/journal-builder-catalogue.
  const item = { ...event, pk: key.pk, sk: key.sk } as unknown as StoredItem;
  return { key, event, item };
}

/**
 * The conditional put that appends an entry, alone or inside a caller-owned transaction. The
 * `item_absent` condition makes a second write at the same `(source, instance, sequence)` fail
 * instead of overwriting evidence.
 *
 * @example
 * await store.transact([journalPutAction('caller_journal', prepared), dispatchTransition], token);
 */
export function journalPutAction(table: JournalTableRole, entry: JournalEntry): PutAction {
  return { kind: 'put', table, item: entry.item, condition: { kind: 'item_absent' } };
}

/**
 * Whether a stored item is exactly this entry: same key and structurally equal content
 * (BR-RUA-034). A write that reports a condition failure on such an item was in fact applied.
 *
 * @example
 * isSameStoredEntry(outcome.existing, entry); // true when the earlier attempt landed
 */
export function isSameStoredEntry(existing: StoredItem, entry: JournalEntry): boolean {
  return structurallyEqual(existing, entry.item);
}
