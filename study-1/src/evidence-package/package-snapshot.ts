// Reading a stored package and its amendments through the file system port, as the verifier needs
// them: every regular file as exact bytes, and every other non-directory entry kept aside so the
// verifier can refuse it (`UNINDEXED_FILE`). Every top-level entry of the execution's amendments
// directory is one amendment snapshot; a stray file there becomes an amendment without an index,
// which the verifier rejects, so nothing in the amendments area is skipped silently.

import { ok } from '../record-contract/primitives.ts';
import type { ExecutionIdentity, Result } from '../record-contract/primitives.ts';
import type { AmendmentSnapshot } from './amendment-snapshots.ts';
import type { FileSystemFailure, FsEntry, PackageFile, PackageFileSystem } from './package-file-system.ts';
import { PACKAGE_LAYOUT } from './package-layout.ts';
import type { PackageSnapshot } from './package-verifier.ts';

/**
 * Reads the original package of an execution.
 *
 * @example
 * const original = await readPackageSnapshot(fs, identity);
 * if (original.ok) verifyPackage({ identity, original: original.value, ... }, deps);
 */
export async function readPackageSnapshot(
  fs: PackageFileSystem,
  identity: ExecutionIdentity,
): Promise<Result<PackageSnapshot, FileSystemFailure>> {
  const directory = PACKAGE_LAYOUT.executionDirectory(identity);
  const listed = await fs.list(directory);
  return listed.ok ? readEntries(fs, directory, listed.value) : listed;
}

/**
 * Reads every amendment directory of an execution; none when the amendments directory is absent.
 *
 * @example
 * const amendments = await readAmendmentSnapshots(fs, identity);
 */
export async function readAmendmentSnapshots(
  fs: PackageFileSystem,
  identity: ExecutionIdentity,
): Promise<Result<readonly AmendmentSnapshot[], FileSystemFailure>> {
  const directory = PACKAGE_LAYOUT.amendmentsDirectory(identity);
  const listed = await fs.list(directory);
  if (!listed.ok) {
    return listed.error.code === 'NOT_FOUND' ? ok([]) : listed;
  }
  const snapshots: AmendmentSnapshot[] = [];
  for (const [name, members] of groupByTopLevel(listed.value)) {
    const read = await readEntries(fs, `${directory}/${name}`, members);
    if (!read.ok) {
      return read;
    }
    snapshots.push({ directory: name, ...read.value });
  }
  return ok(snapshots);
}

function groupByTopLevel(entries: readonly FsEntry[]): ReadonlyMap<string, readonly FsEntry[]> {
  const groups = new Map<string, FsEntry[]>();
  for (const entry of entries) {
    const slash = entry.path.indexOf('/');
    const name = slash === -1 ? entry.path : entry.path.slice(0, slash);
    const members = groups.get(name) ?? [];
    groups.set(name, slash === -1 ? members : [...members, { ...entry, path: entry.path.slice(slash + 1) }]);
  }
  return groups;
}

async function readEntries(
  fs: PackageFileSystem,
  directory: string,
  entries: readonly FsEntry[],
): Promise<Result<PackageSnapshot, FileSystemFailure>> {
  const files: PackageFile[] = [];
  for (const entry of entries.filter((candidate) => candidate.type === 'file')) {
    const bytes = await fs.read(`${directory}/${entry.path}`);
    if (!bytes.ok) {
      return bytes;
    }
    files.push({ path: entry.path, bytes: bytes.value });
  }
  const specialEntries = entries.filter((entry) => entry.type !== 'file' && entry.type !== 'directory');
  return ok({ files, special_entries: specialEntries });
}
