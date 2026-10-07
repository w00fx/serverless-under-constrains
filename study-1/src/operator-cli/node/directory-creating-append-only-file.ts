// Local file-system binding of the AppendOnlyFile port for journals named by absolute paths whose
// directory may not exist yet: admission's preflight journal lives in
// `<evidence root>/admission-attempts/<id>/`, a directory nothing creates before step A1 appends
// its first line. The parent directory is created first, because `NodeAppendOnlyFile` appends to
// an existing directory only (decision 84). Every outcome is the inner file's.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AppendOnlyFile, FileAppendOutcome, FileFinalizeOutcome } from '../../event-journal/append-only-file.ts';
import { NodeAppendOnlyFile } from '../../event-journal/node/node-append-only-file.ts';

/**
 * An append-only file that creates the parent directories of a journal before touching it.
 *
 * @example
 * const journal = new DirectoryCreatingAppendOnlyFile();
 * await journal.append('/study-1/evidence/admission-attempts/<id>/preflight-journal.jsonl', line); // { kind: 'appended' }
 */
export class DirectoryCreatingAppendOnlyFile implements AppendOnlyFile {
  readonly #inner: AppendOnlyFile;

  constructor(inner: AppendOnlyFile = new NodeAppendOnlyFile()) {
    this.#inner = inner;
  }

  async append(path: string, bytes: Uint8Array): Promise<FileAppendOutcome> {
    await createParent(path);
    return this.#inner.append(path, bytes);
  }

  async finalize(path: string): Promise<FileFinalizeOutcome> {
    await createParent(path);
    return this.#inner.finalize(path);
  }
}

// A directory that cannot be created is left to the inner file, which reports its open failure.
async function createParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
}
