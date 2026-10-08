// Writes into one execution's package (design §7; BR-RUA-043, BR-RUA-044). Every file is created
// once at its package-relative path below the execution directory: a file that already exists is
// never replaced, and a refused or failed write becomes a reason the phase records, never a throw.

import type { PackageFile, PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { readPackageSnapshot } from '../evidence-package/package-snapshot.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { ExecutionIdentity, Result, StructuredReason } from '../record-contract/primitives.ts';

/** One execution's package as the runner writes and reads it. */
export class ExecutionPackage {
  readonly #files: PackageFileSystem;
  readonly #directory: string;
  readonly #identity: ExecutionIdentity;

  constructor(files: PackageFileSystem, identity: ExecutionIdentity, directory: string) {
    this.#files = files;
    this.#identity = identity;
    this.#directory = directory;
  }

  /**
   * Creates the package file at `path` (package-relative); the reason it was not written, if any.
   *
   * @example
   * await pkg.writeOnce('summary/safety-assessment.json', bytes); // undefined once written
   */
  async writeOnce(path: string, bytes: Uint8Array): Promise<StructuredReason | undefined> {
    const written = await this.#files.writeOnce(`${this.#directory}/${path}`, bytes);
    if (written.ok) {
      return undefined;
    }
    return {
      code: 'PACKAGE_FILE_NOT_WRITTEN',
      subject: 'BR-RUA-044',
      artifact_path: path,
      detail: `${path} was not written (${written.error.code}: ${written.error.detail}); expected a new write-once package file`,
    };
  }

  /**
   * Every regular file of the package as exact bytes, at package-relative paths.
   *
   * @example
   * const files = await pkg.snapshot();
   * if (files.ok) files.value.find((file) => file.path === 'runner/runner-journal.jsonl');
   */
  async snapshot(): Promise<Result<readonly PackageFile[], StructuredReason>> {
    const read = await readPackageSnapshot(this.#files, this.#identity);
    if (!read.ok) {
      return err({
        code: 'PACKAGE_UNREADABLE',
        subject: 'BR-RUA-044',
        detail: `${this.#directory} could not be read (${read.error.code}: ${read.error.detail}); expected the execution package`,
      });
    }
    return ok(read.value.files);
  }
}

/**
 * The package files keyed by path, as the record readers take them.
 *
 * @example
 * filesByPath(files).get('admission/execution-manifest.json');
 */
export function filesByPath(files: readonly PackageFile[]): ReadonlyMap<string, Uint8Array> {
  return new Map(files.map((file) => [file.path, file.bytes]));
}
