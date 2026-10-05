// A journal kept as a JSONL file (BR-RUA-033): one canonical event per line, UTF-8, each line
// ending with a newline. The file medium reports what it knows about the bytes; this port maps
// that onto the store outcome vocabulary the writer reads.

import { serializeJsonl } from '../record-contract/canonical-json.ts';
import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import type { AppendOnlyFile, FileAppendOutcome } from './append-only-file.ts';
import type { JournalAppendPort } from './journal-append-port.ts';

/**
 * Binds one JSONL file to the append port. A finalized file refuses every append, which the
 * writer sees as a definitive failure.
 *
 * @example
 * const port = createJsonlJournalPort('evidence/<run>/runner/runner-journal.jsonl', new NodeAppendOnlyFile());
 */
export function createJsonlJournalPort(path: string, file: AppendOnlyFile): JournalAppendPort {
  if (path.length === 0) {
    throw new RangeError('JSONL journal path ""; expected a non-empty file path');
  }
  return {
    append: async (entry) => toWriteOutcome(await file.append(path, serializeJsonl([entry.event]))),
  };
}

/**
 * Maps a file outcome onto a store outcome: written bytes are `applied`, unwritten bytes a
 * `definitive_failure`, and bytes of unknown fate `ambiguous`.
 *
 * @example
 * toWriteOutcome({ kind: 'unknown', code: 'EIO' }); // { kind: 'ambiguous', code: 'EIO' }
 */
export function toWriteOutcome(outcome: FileAppendOutcome): WriteOutcome {
  switch (outcome.kind) {
    case 'appended':
      return { kind: 'applied' };
    case 'not_written':
      return { kind: 'definitive_failure', code: outcome.code };
    case 'unknown':
      return { kind: 'ambiguous', code: outcome.code };
  }
}
