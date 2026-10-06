// One durable attempt transition with its journal event (design §5.3 C1-C3): the writer
// reserves the event, the attempt-state port writes it in the same transaction as the state
// change, and the writer settles the reservation with the transaction's outcome. The result
// says what the evidence now proves:
// - `applied`: the state changed and the event exists;
// - `rejected`: the store definitively refused the transaction; nothing changed;
// - `condition_failed`: a condition did not hold (the attempt was not in the expected phase,
//   or another event occupies the journal key); nothing changed;
// - `ambiguous`: nobody can tell whether it applied (an ambiguous store outcome, a port that
//   threw, or a journal instance that can no longer emit events, BR-RUA-033).

import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import type { ConfirmResult } from '../event-journal/journal-append-port.ts';
import type { EventBody, JournalEvent } from '../event-journal/journal-event.ts';
import type { JournalWriter, PreparedJournalPut } from '../event-journal/journal-writer.ts';
import type { Uuid4 } from '../record-contract/primitives.ts';
import { ATTEMPT_JOURNAL_ACTION_INDEX } from './attempt-state-port.ts';

export type TransitionEventType = 'attempt_registered' | 'attempt_not_dispatched' | 'dispatch_started';

export type TransitionResult =
  | { readonly kind: 'applied'; readonly event: JournalEvent }
  | { readonly kind: 'rejected' | 'condition_failed' | 'ambiguous' };

/**
 * Runs one transition. `write` receives the reserved event and returns the transaction outcome.
 *
 * @example
 * const result = await runDurableTransition(journal, 'dispatch_started', body, [registeredEventId],
 *   (put) => attempts.transitionToDispatched(attemptId, put));
 */
export async function runDurableTransition<T extends TransitionEventType>(
  journal: JournalWriter,
  type: T,
  body: EventBody<T>,
  causation: readonly Uuid4[],
  write: (put: PreparedJournalPut) => Promise<WriteOutcome>,
): Promise<TransitionResult> {
  const prepared = journal.prepare(type, body, causation);
  if (prepared.kind === 'stopped') {
    return { kind: 'ambiguous' };
  }
  const outcome = await writeOrAmbiguous(write, prepared.put);
  return transitionResultOf(journal.confirm(prepared.put, outcome, ATTEMPT_JOURNAL_ACTION_INDEX));
}

// A port that throws gives no proof either way, exactly like an ambiguous store outcome. The
// code is fixed: an ambiguous outcome only stops the journal, so nothing downstream reads it.
async function writeOrAmbiguous(
  write: (put: PreparedJournalPut) => Promise<WriteOutcome>,
  put: PreparedJournalPut,
): Promise<WriteOutcome> {
  try {
    return await write(put);
  } catch {
    return { kind: 'ambiguous', code: 'ATTEMPT_STATE_PORT_THREW' };
  }
}

function transitionResultOf(confirmed: ConfirmResult): TransitionResult {
  switch (confirmed.kind) {
    case 'appended':
      return { kind: 'applied', event: confirmed.event };
    case 'not_applied':
      return { kind: confirmed.outcome.kind === 'definitive_failure' ? 'rejected' : 'condition_failed' };
    case 'stopped':
      return { kind: confirmed.reason === 'SEQUENCE_CONFLICT' ? 'condition_failed' : 'ambiguous' };
  }
}
