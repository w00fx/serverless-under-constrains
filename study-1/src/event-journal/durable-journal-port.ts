// A journal kept in a journal table of the durable item store (design §9.3): the caller journal
// (its stream feeds the treatment controller) or the experiment journal (provider and
// controller events). Each event is one conditional put, so a second write at the same
// (source, instance, sequence) can never overwrite evidence.

import type { DurableItemStore } from '../durable-store/item-store-port.ts';
import type { JournalAppendPort } from './journal-append-port.ts';
import type { JournalTableRole } from './journal-entry.ts';
import { journalPutAction } from './journal-entry.ts';

/**
 * Binds a journal table to the append port.
 *
 * @example
 * const port = createDurableJournalPort(store, 'experiment_journal');
 */
export function createDurableJournalPort(store: DurableItemStore, table: JournalTableRole): JournalAppendPort {
  return { append: (entry) => store.write(journalPutAction(table, entry)) };
}
