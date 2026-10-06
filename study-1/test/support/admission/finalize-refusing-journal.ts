// FinalizeRefusingJournal (design §12.2): the memory AppendOnlyFile emulator with one more fault,
// a finalize that fails, as `NodeAppendOnlyFile.finalize` does when it cannot make the journal
// read-only (a `chmod` that fails). Every other behavior is the emulator's, which the shared
// AppendOnlyFile suite proves against the real binding; the refusal leaves the file appendable,
// so a later finalize can still close it.

import type { FileFinalizeOutcome } from '../../../src/event-journal/append-only-file.ts';
import { MemoryAppendOnlyFile } from '../event-journal/memory-append-only-file.ts';

/**
 * The emulator whose next `count` finalize calls fail with `code`.
 *
 * @example
 * const journal = new FinalizeRefusingJournal();
 * journal.refuseFinalize(1, 'EPERM');
 * await journal.finalize('a.jsonl'); // { kind: 'failed', code: 'EPERM' }
 */
export class FinalizeRefusingJournal extends MemoryAppendOnlyFile {
  #refusals = 0;
  #code = 'EIO';

  /** The next `count` finalize calls fail with `code`, finalizing nothing. */
  refuseFinalize(count: number, code = 'EIO'): void {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError(`count ${String(count)}; expected a positive safe integer`);
    }
    this.#refusals = count;
    this.#code = code;
  }

  override finalize(path: string): Promise<FileFinalizeOutcome> {
    if (this.#refusals === 0) {
      return super.finalize(path);
    }
    this.#refusals -= 1;
    return Promise.resolve({ kind: 'failed', code: this.#code });
  }
}
