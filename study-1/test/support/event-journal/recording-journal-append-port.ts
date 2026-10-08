// A recording decorator of the JournalAppendPort (design §12.2): it forwards every entry to a
// real port (a journal table over InMemoryItemStore, or a JSONL file over MemoryAppendOnlyFile)
// and records each entry it was given, so a test can prove that a retry resent the identical
// event (BR-RUA-033) and that a stopped instance sent nothing more.
//
// Fault injection: `throwNext(error)` makes the next append throw instead of returning an
// outcome, as a port with a defect would; `answerNext(outcome)` makes the next append return
// `outcome`, for outcomes the inner fake cannot produce (for example a condition failure whose
// ALL_OLD image did not decode, so `existing` is omitted). In both cases the inner port is not
// called.

import type { WriteOutcome } from '../../../src/durable-store/item-store-port.ts';
import type { JournalAppendPort } from '../../../src/event-journal/journal-append-port.ts';
import type { JournalEntry } from '../../../src/event-journal/journal-entry.ts';

export class RecordingJournalAppendPort implements JournalAppendPort {
  readonly #inner: JournalAppendPort;
  readonly #entries: JournalEntry[] = [];
  readonly #outcomes: WriteOutcome[] = [];
  readonly #thrown: unknown[] = [];
  readonly #answers: WriteOutcome[] = [];

  constructor(inner: JournalAppendPort) {
    this.#inner = inner;
  }

  async append(entry: JournalEntry): Promise<WriteOutcome> {
    this.#entries.push(entry);
    if (this.#thrown.length > 0) {
      throw this.#thrown.shift();
    }
    const answer = this.#answers.shift();
    if (answer !== undefined) {
      return answer;
    }
    const outcome = await this.#inner.append(entry);
    this.#outcomes.push(outcome);
    return outcome;
  }

  /** The next append throws `error` without reaching the inner port. */
  throwNext(error: unknown): void {
    this.#thrown.push(error);
  }

  /** The next append returns `outcome` without reaching the inner port. */
  answerNext(outcome: WriteOutcome): void {
    this.#answers.push(outcome);
  }

  /** Every entry passed to `append`, in call order (thrown calls included). */
  entries(): readonly JournalEntry[] {
    return [...this.#entries];
  }

  /** The outcome of every append that reached the inner port, in call order. */
  outcomes(): readonly WriteOutcome[] {
    return [...this.#outcomes];
  }
}
