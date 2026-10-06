// Reads one assembly directory as the inventory sees it (BR-RUA-042): every `lstat` entry below
// the root and the exact bytes of every regular file. Symbolic links and special files are listed
// but never read, so the inventory can reject them; nothing is followed out of the directory.

import { join } from 'node:path';

import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { FsEntry, PackageFile } from '../evidence-package/package-file-system.ts';
import type { AssemblyFileSystem } from './assembly-file-system.ts';
import { deploymentReason } from './deployment-reasons.ts';

/** An assembly directory: its entries, paths relative to the root, and its regular files' bytes. */
export interface AssemblyListing {
  readonly entries: readonly FsEntry[];
  readonly files: readonly PackageFile[];
}

/**
 * Lists `directory` and reads every regular file below it.
 *
 * @example
 * const listing = await readAssemblyListing(files, '/work/evidence/runs/<id>/admission/deployment-assembly');
 * if (listing.ok) verifyAssemblyUnchanged(inventory, listing.value); // [] when untouched
 */
export async function readAssemblyListing(
  files: AssemblyFileSystem,
  directory: string,
): Promise<Result<AssemblyListing, readonly StructuredReason[]>> {
  const listed = await files.list(directory);
  if (!listed.ok) {
    return err([
      deploymentReason(
        'ASSEMBLY_UNREADABLE',
        'BR-RUA-042',
        `${listed.error.code}: ${listed.error.detail}; expected a readable assembly directory`,
      ),
    ]);
  }
  const read: PackageFile[] = [];
  for (const entry of listed.value.filter((candidate) => candidate.type === 'file')) {
    const bytes = await files.read(join(directory, entry.path));
    if (!bytes.ok) {
      return err([
        deploymentReason(
          'ASSEMBLY_UNREADABLE',
          'BR-RUA-042',
          `${bytes.error.code}: ${bytes.error.detail}; expected the bytes of every regular file`,
        ),
      ]);
    }
    read.push({ path: entry.path, bytes: bytes.value });
  }
  return ok({ entries: listed.value, files: read });
}
