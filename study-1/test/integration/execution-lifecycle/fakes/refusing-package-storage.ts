// The offline evidence root with regions that refuse: every `writeOnce` below a refused prefix
// fails, as a full or read-only volume would answer, and listing a refused directory fails, as an
// unreadable directory would; the rest of the root behaves as the offline storage. The port has no
// distinct codes for these, so both are IO_ERRORs whose detail names the cause. Recovery must then
// report the amendment it could not read or write instead of a partial one (BR-RUA-043).

import type { FileSystemFailure, FsEntry } from '../../../../src/evidence-package/package-file-system.ts';
import type { Result } from '../../../../src/record-contract/primitives.ts';
import { OfflinePackageStorage } from '../../../support/offline-cloud/offline-package-storage.ts';

/**
 * Offline package storage that refuses to create files under chosen prefixes or list chosen roots.
 *
 * @example
 * const storage = new RefusingPackageStorage();
 * storage.refuseWritesUnder('runs/x/amendments/');
 * await storage.writeOnce('runs/x/amendments/0001/amendment-index.json', bytes); // { ok: false, error: { code: 'IO_ERROR', … } }
 */
export class RefusingPackageStorage extends OfflinePackageStorage {
  readonly #writePrefixes: string[] = [];
  readonly #listRoots = new Set<string>();

  /** Every later file creation under `prefix` fails. */
  refuseWritesUnder(prefix: string): void {
    this.#writePrefixes.push(prefix);
  }

  /** Every later listing of exactly `root` fails. */
  refuseListing(root: string): void {
    this.#listRoots.add(root);
  }

  override writeOnce(path: string, bytes: Uint8Array): Promise<Result<void, FileSystemFailure>> {
    if (this.#writePrefixes.some((prefix) => path.startsWith(prefix))) {
      return Promise.resolve({
        ok: false,
        error: { code: 'IO_ERROR', detail: `ENOSPC: ${path} is under a refused prefix; expected a writable volume` },
      });
    }
    return super.writeOnce(path, bytes);
  }

  override list(root: string): Promise<Result<readonly FsEntry[], FileSystemFailure>> {
    if (this.#listRoots.has(root)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'IO_ERROR', detail: `EACCES: ${root} is a refused directory; expected a readable one` },
      });
    }
    return super.list(root);
  }
}
