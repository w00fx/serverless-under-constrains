// The payload of an amendment while it is being built (BR-RUA-043; design §7 amendments). An
// amendment is written as a whole, payload first and its index last, only once every payload file
// is known; until then recovery collects the files in memory: the pre-cleanup snapshot, the cleanup
// journal (an append-only JSONL file like the package's) and the frozen results.

import type { AppendOnlyFile, FileAppendOutcome, FileFinalizeOutcome } from '../event-journal/append-only-file.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { EvidenceSink } from './cleanup-evidence.ts';

/**
 * Payload files of one amendment, at paths relative to the amendment directory.
 *
 * @example
 * const payload = new AmendmentPayload();
 * await payload.writeOnce('payload/cleanup-result.json', bytes);
 * payload.files(); // [{ path: 'payload/cleanup-result.json', bytes }]
 */
export class AmendmentPayload implements EvidenceSink, AppendOnlyFile {
  readonly #files = new Map<string, Uint8Array>();

  writeOnce(path: string, bytes: Uint8Array): Promise<StructuredReason | undefined> {
    if (this.#files.has(path)) {
      return Promise.resolve({
        code: 'PAYLOAD_FILE_EXISTS',
        subject: 'BR-RUA-043',
        artifact_path: path,
        detail: `${path} is already in the amendment payload; expected each payload file written once`,
      });
    }
    this.#files.set(path, bytes);
    return Promise.resolve(undefined);
  }

  append(path: string, bytes: Uint8Array): Promise<FileAppendOutcome> {
    const existing = this.#files.get(path) ?? new Uint8Array();
    const joined = new Uint8Array(existing.length + bytes.length);
    joined.set(existing);
    joined.set(bytes, existing.length);
    this.#files.set(path, joined);
    return Promise.resolve({ kind: 'appended' });
  }

  // The payload is written whole once built; nothing appends after that.
  finalize(): Promise<FileFinalizeOutcome> {
    return Promise.resolve({ kind: 'finalized' });
  }

  /** The bytes at `path`, or an empty file when nothing was written there. */
  bytesAt(path: string): Uint8Array {
    return this.#files.get(path) ?? new Uint8Array();
  }

  /** Every payload file, sorted by path. */
  files(): readonly PackageFile[] {
    return [...this.#files].map(([path, bytes]) => ({ path, bytes })).toSorted((a, b) => (a.path < b.path ? -1 : 1));
  }
}
