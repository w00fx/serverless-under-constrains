// The append port every journal medium implements, the results the writer reports, and the
// BR-RUA-033 reading of a store outcome for one journal entry.

import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import type { JournalEntry } from './journal-entry.ts';
import { holdsEntryKey, isSameStoredEntry } from './journal-entry.ts';
import type { JournalEvent } from './journal-event.ts';

/** One journal medium: a journal table (`createDurableJournalPort`) or a JSONL file (`createJsonlJournalPort`). */
export interface JournalAppendPort {
  append(entry: JournalEntry): Promise<WriteOutcome>;
}

/**
 * Why a source instance stopped emitting events (BR-RUA-033):
 * - `AMBIGUOUS_APPEND`: the medium could not say whether the event was stored;
 * - `DEFINITIVE_RETRIES_EXHAUSTED`: every identical retry of a definitively failed append failed;
 * - `SEQUENCE_CONFLICT`: other content already occupies this instance's next sequence;
 * - `INSTANCE_ALREADY_STOPPED`: an earlier append stopped the instance; a restart needs a new one.
 */
export type JournalStopReason =
  'AMBIGUOUS_APPEND' | 'DEFINITIVE_RETRIES_EXHAUSTED' | 'SEQUENCE_CONFLICT' | 'INSTANCE_ALREADY_STOPPED';

export interface JournalStopped {
  readonly kind: 'stopped';
  readonly reason: JournalStopReason;
}

export type AppendResult = { readonly kind: 'appended'; readonly event: JournalEvent } | JournalStopped;

/**
 * The result of confirming a put that a caller-owned transaction carried. `not_applied` means
 * the transaction was definitively not applied (a failed condition of the transaction, or a
 * definitive failure): the event does not exist and its sequence is free for the next event.
 */
export type ConfirmResult =
  AppendResult | { readonly kind: 'not_applied'; readonly event: JournalEvent; readonly outcome: WriteOutcome };

/** A reserved put for a caller-owned transaction, or the reason the instance can no longer emit. */
export type PrepareResult = { readonly kind: 'prepared'; readonly put: JournalEntry } | JournalStopped;

/** What one store outcome means for one journal entry. */
export type JournalOutcomeClass = 'applied' | 'not_applied' | 'ambiguous' | 'sequence_conflict';

/**
 * Reads a store outcome for an entry written with `journalPutAction`. A failed condition on an
 * item at the entry's own key is the entry itself when the content is identical (an earlier
 * write landed), and a sequence conflict otherwise. A failed condition anywhere else, or a
 * definitive failure, left the entry unwritten.
 *
 * @example
 * classifyJournalOutcome({ kind: 'ambiguous', code: 'TimeoutError' }, entry); // 'ambiguous'
 */
export function classifyJournalOutcome(outcome: WriteOutcome, entry: JournalEntry): JournalOutcomeClass {
  switch (outcome.kind) {
    case 'applied':
      return 'applied';
    case 'ambiguous':
      return 'ambiguous';
    case 'definitive_failure':
      return 'not_applied';
    case 'condition_failed':
      return classifyConditionFailure(outcome.existing, entry);
  }
}

function classifyConditionFailure(
  existing: JournalEntry['item'] | undefined,
  entry: JournalEntry,
): JournalOutcomeClass {
  if (existing === undefined || !holdsEntryKey(existing, entry)) {
    return 'not_applied';
  }
  return isSameStoredEntry(existing, entry) ? 'applied' : 'sequence_conflict';
}
