// Local file-system binding of the AppendOnlyFile port rooted at one evidence directory (design §7
// journals): the runner, the coordination lease, the trial executor and the provisioner all name
// their journals by paths relative to the evidence root (`<package>/runner/runner-journal.jsonl`),
// exactly as the package file system names package files. Each path is checked as a normalized
// relative POSIX path (BR-RUA-035) before it is joined to the root, so a journal can never be
// written outside the evidence directory, and the parent directory is created first by the default
// inner `DirectoryCreatingAppendOnlyFile`, because `NodeAppendOnlyFile` appends to an existing
// directory only. Every outcome is the inner file's.

import { join } from 'node:path';

import type { AppendOnlyFile, FileAppendOutcome, FileFinalizeOutcome } from '../../event-journal/append-only-file.ts';
import { invalidPathReason } from '../../evidence-package/artifact-classification.ts';
import { DirectoryCreatingAppendOnlyFile } from './directory-creating-append-only-file.ts';

/** The refusal code of a path that would leave the evidence root. */
export const INVALID_JOURNAL_PATH = 'INVALID_PATH';

/**
 * The journals below one evidence root.
 *
 * @example
 * const journals = new EvidenceJournalFile('/study-1/evidence');
 * await journals.append('runs/<id>/runner/runner-journal.jsonl', line); // { kind: 'appended' }
 */
export class EvidenceJournalFile implements AppendOnlyFile {
  readonly #root: string;
  readonly #inner: AppendOnlyFile;

  constructor(root: string, inner: AppendOnlyFile = new DirectoryCreatingAppendOnlyFile()) {
    this.#root = root;
    this.#inner = inner;
  }

  async append(path: string, bytes: Uint8Array): Promise<FileAppendOutcome> {
    const target = this.#prepared(path);
    return target === undefined
      ? { kind: 'not_written', code: INVALID_JOURNAL_PATH }
      : this.#inner.append(target, bytes);
  }

  async finalize(path: string): Promise<FileFinalizeOutcome> {
    const target = this.#prepared(path);
    return target === undefined ? { kind: 'failed', code: INVALID_JOURNAL_PATH } : this.#inner.finalize(target);
  }

  // The absolute path below the root; undefined for a path outside the root.
  #prepared(path: string): string | undefined {
    return invalidPathReason(path) === undefined ? join(this.#root, path) : undefined;
  }
}
