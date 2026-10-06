// The cleanup journal of one cleanup run (design §7 `cleanup/cleanup-journal.jsonl`): one
// `cleanup_action_recorded` per action, appended by one `cleanup` source instance (BR-RUA-033).
//
// Cleanup must not stop because its journal stopped: an ambiguous append stops the source
// instance for good (BR-RUA-033), but owned infrastructure still has to be deleted (BR-RUA-046
// "exceeding it is a duration breach rather than permission to abandon cleanup"). So every
// action is also kept in memory, the frozen cleanup result is built from that account, and the
// first append the journal refuses becomes a reason on the step it happened in. Reasons are made
// schema-conforming first (`reason-conformance.ts`), so a re-run can read every line back.

import type { JournalWriter } from '../event-journal/journal-writer.ts';
import type { StructuredReason, WallClock } from '../record-contract/primitives.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { CleanupActionBody, CleanupActionEntry } from './cleanup-action-fold.ts';
import { conformingReason } from './reason-conformance.ts';

/**
 * Records cleanup actions in the journal and in memory.
 *
 * @example
 * const journal = new CleanupJournal(writer, clock);
 * await journal.record({ step: 9, step_status: 'started', cleanup_mode: 'NORMAL', cleanup_induced: false, action: 'OWNED_RESOURCES_DELETE', reasons: [] });
 * journal.entries().length; // 1
 */
export class CleanupJournal {
  readonly #writer: JournalWriter;
  readonly #clock: WallClock;
  readonly #entries: CleanupActionEntry[] = [];
  #pendingFailure: StructuredReason | undefined;
  #stopReported = false;

  constructor(writer: JournalWriter, clock: WallClock) {
    this.#writer = writer;
    this.#clock = clock;
  }

  /** Appends one action, its reasons made schema-conforming; keeps it in memory whether or not the journal accepted it. */
  async record(action: CleanupActionBody): Promise<void> {
    const body = { ...action, reasons: action.reasons.map(conformingReason) };
    const result = await this.#writer.append('cleanup_action_recorded', body);
    if (result.kind === 'appended') {
      this.#entries.push({ body, occurred_at: result.event.occurred_at });
      return;
    }
    this.#entries.push({ body, occurred_at: formatUtcMillis(this.#clock.now()) });
    if (!this.#stopReported) {
      this.#stopReported = true;
      this.#pendingFailure = {
        code: 'CLEANUP_JOURNAL_STOPPED',
        subject: 'cleanup-journal.jsonl',
        detail: `append of ${body.action} for step ${String(body.step)} returned ${result.reason}: ${result.detail}; expected appended, so later actions are kept only in the cleanup result`,
      };
    }
  }

  /** The journal failure not yet attached to a step, cleared by this call. */
  takeFailure(): readonly StructuredReason[] {
    const failure = this.#pendingFailure;
    this.#pendingFailure = undefined;
    return failure === undefined ? [] : [failure];
  }

  /** Every action this run recorded, oldest first. */
  entries(): readonly CleanupActionEntry[] {
    return [...this.#entries];
  }
}
