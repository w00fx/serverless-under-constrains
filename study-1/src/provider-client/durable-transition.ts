// One durable attempt transition with its journal event (design §5.3 C1-C3): the writer
// reserves the event, the attempt-state port writes it in the same transaction as the state
// change, and the writer settles the reservation with the transaction's outcome. A transaction
// the store definitively refused is resubmitted unchanged (`JournalWriter.prepareRetry`: same
// event identity, content and sequence) up to the writer's definitive-retry budget, as
// BR-RUA-033 requires of every append (WP-06 review round 2). The result says what the
// evidence now proves:
// - `applied`: the state changed and the event exists;
// - `rejected`: the store definitively refused the transaction on every try; nothing changed;
// - `condition_failed`: a condition did not hold (the attempt was not in the expected phase,
//   or another event occupies the journal key); nothing changed;
// - `ambiguous`: nobody can tell whether it applied (an ambiguous store outcome, a port that
//   threw, or a journal instance that can no longer emit events, BR-RUA-033).

import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import type { ConfirmResult } from '../event-journal/journal-append-port.ts';
import type { EventBody, JournalEvent } from '../event-journal/journal-event.ts';
import type { JournalWriter, PreparedJournalPut } from '../event-journal/journal-writer.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import type { Uuid4 } from '../record-contract/primitives.ts';
import { ATTEMPT_JOURNAL_ACTION_INDEX } from './attempt-state-port.ts';
import { transportErrorFromThrown } from './provider-invocation-port.ts';

export type TransitionEventType = 'attempt_registered' | 'attempt_not_dispatched' | 'dispatch_started';

export type TransitionResult =
  | { readonly kind: 'applied'; readonly event: JournalEvent }
  | { readonly kind: 'rejected' | 'condition_failed' | 'ambiguous' };

/** One transition: its journal event and the transaction that writes it. */
export interface DurableTransition<T extends TransitionEventType> {
  readonly type: T;
  readonly body: EventBody<T>;
  readonly causation: readonly Uuid4[];
  /** Writes the reserved event with the state change and returns the transaction outcome. */
  readonly write: (put: PreparedJournalPut) => Promise<WriteOutcome>;
}

/** The code prefix of the ambiguous outcome that stands for a throwing attempt-state port. */
export const PORT_THREW_CODE = 'ATTEMPT_STATE_PORT_THREW';

/**
 * Runs one transition. `maxDefinitiveRetries` is the writer's own budget of identical retries
 * after a definitive failure (0 = no retry); a transaction refused on every try is `rejected`.
 *
 * @example
 * const result = await runDurableTransition(journal, 2, { type: 'dispatch_started', body,
 *   causation: [registeredEventId], write: (put) => attempts.transitionToDispatched(attemptId, put) });
 */
export async function runDurableTransition<T extends TransitionEventType>(
  journal: JournalWriter,
  maxDefinitiveRetries: number,
  transition: DurableTransition<T>,
): Promise<TransitionResult> {
  let prepared = journal.prepare(transition.type, transition.body, transition.causation);
  for (let retry = 0; prepared.kind === 'prepared'; retry += 1) {
    const outcome = await writeOrAmbiguous(transition.write, prepared.put);
    const confirmed = journal.confirm(prepared.put, outcome, ATTEMPT_JOURNAL_ACTION_INDEX);
    if (!isDefinitiveFailure(confirmed) || retry >= maxDefinitiveRetries) {
      return transitionResultOf(confirmed);
    }
    prepared = journal.prepareRetry(prepared.put);
  }
  return { kind: 'ambiguous' };
}

// Only a refusal by the store is retried identically: a failed condition would fail again.
function isDefinitiveFailure(confirmed: ConfirmResult): boolean {
  return confirmed.kind === 'not_applied' && confirmed.outcome.kind === 'definitive_failure';
}

// A port that throws gives no proof either way, exactly like an ambiguous store outcome. The
// code names what was thrown (bounded), so the stopped writer's detail keeps a trace of it.
async function writeOrAmbiguous(
  write: (put: PreparedJournalPut) => Promise<WriteOutcome>,
  put: PreparedJournalPut,
): Promise<WriteOutcome> {
  try {
    return await write(put);
  } catch (thrown: unknown) {
    const { error_name, message } = transportErrorFromThrown(thrown);
    return {
      kind: 'ambiguous',
      code: `${PORT_THREW_CODE}: ${boundedJsonText(error_name)} ${boundedJsonText(message)}`,
    };
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
