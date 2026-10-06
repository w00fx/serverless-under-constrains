// The append port every journal medium implements, the results the writer reports, and the
// BR-RUA-033 reading of a store outcome for one journal entry.

import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import type { JournalEntry } from './journal-entry.ts';
import { isSameStoredEntry } from './journal-entry.ts';
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
  /** The triggering item key and outcome (its code, or the error the port threw), for operators. */
  readonly detail: string;
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
 * Reads a store outcome for an entry written with `journalPutAction`. `journalActionIndex` is
 * the position of that put in the write: 0 for a standalone append, or the put's index inside a
 * caller-owned transaction. It is required: without it, a failed `item_absent` condition on the
 * put itself that comes back without a decodable item (WP-04 omits an undecodable ALL_OLD
 * image) could not be told from a failed business condition, and an occupied sequence would be
 * freed (WP-05 review round 2).
 *
 * A failed condition on the entry's own put is the entry itself when the item there holds
 * identical content (an earlier write landed), and a sequence conflict otherwise, including
 * when the store returned no decodable item (an `item_absent` put fails only on an occupied
 * key). A failed condition on another action, or a definitive failure, left the entry unwritten.
 *
 * @example
 * classifyJournalOutcome({ kind: 'ambiguous', code: 'TimeoutError' }, entry, 0); // 'ambiguous'
 * classifyJournalOutcome({ kind: 'condition_failed', failed_action_index: 0 }, entry, 0); // 'sequence_conflict'
 */
export function classifyJournalOutcome(
  outcome: WriteOutcome,
  entry: JournalEntry,
  journalActionIndex: number,
): JournalOutcomeClass {
  switch (outcome.kind) {
    case 'applied':
      return 'applied';
    case 'ambiguous':
      return 'ambiguous';
    case 'definitive_failure':
      return 'not_applied';
    case 'condition_failed':
      return classifyConditionFailure(outcome.failed_action_index, outcome.existing, entry, journalActionIndex);
  }
}

function classifyConditionFailure(
  failedActionIndex: number,
  existing: JournalEntry['item'] | undefined,
  entry: JournalEntry,
  journalActionIndex: number,
): JournalOutcomeClass {
  if (failedActionIndex !== journalActionIndex) {
    return 'not_applied';
  }
  return existing !== undefined && isSameStoredEntry(existing, entry) ? 'applied' : 'sequence_conflict';
}
