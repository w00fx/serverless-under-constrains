// Local assembly directories as admission reads and copies them (BR-RUA-042, design §9.8 S1-S3).
// Admission may import `deployment-assembly/` only for types (design §5.4), so the listing and
// the copy live here, over the same `AssemblyFileSystem` port. A listing holds every `lstat` entry
// and the bytes of every regular file; symbolic links and special files are listed but never
// read or followed, so the inventory rejects them. A copy reproduces each regular file's bytes and
// permission bits, and is then proven equal by re-inventorying it.

import { join } from 'node:path';

import { boundedText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { AssemblyFileSystem } from '../deployment-assembly/assembly-file-system.ts';
import type { FsEntry, PackageFile } from '../evidence-package/package-file-system.ts';
import { admissionReason } from './admission-reason.ts';

const SUBJECT = 'BR-RUA-042';
const PERMISSION_BITS = 0o7777;

/** A regular file of an assembly with the permission bits its `lstat` entry reported. */
export interface AssemblyFile extends PackageFile {
  readonly mode: number;
}

/** One assembly directory: entries relative to its root and the bytes of its regular files. */
export interface AssemblyDirectory {
  readonly entries: readonly FsEntry[];
  readonly files: readonly AssemblyFile[];
}

/**
 * Lists `directory` and reads every regular file below it.
 *
 * @example
 * const listed = await readAssemblyDirectory(files, '/tmp/staging/<attempt>/cdk.out');
 * if (listed.ok) listed.value.files.length; // every regular file of the assembly
 */
export async function readAssemblyDirectory(
  files: AssemblyFileSystem,
  directory: string,
): Promise<Result<AssemblyDirectory, StructuredReason>> {
  const listed = await files.list(directory);
  if (!listed.ok) {
    return err(unreadable(directory, `${listed.error.code}: ${listed.error.detail}`));
  }
  const read: AssemblyFile[] = [];
  for (const entry of listed.value.filter((candidate) => candidate.type === 'file')) {
    const bytes = await files.read(join(directory, entry.path));
    if (!bytes.ok) {
      return err(unreadable(join(directory, entry.path), `${bytes.error.code}: ${bytes.error.detail}`));
    }
    read.push({ path: entry.path, bytes: bytes.value, mode: entry.mode & PERMISSION_BITS });
  }
  return ok({ entries: listed.value, files: read });
}

/**
 * Writes every regular file of `source` below `target` with its bytes and permission bits.
 *
 * @example
 * await copyAssemblyDirectory(listing, '/work/evidence/runs/<id>/admission/deployment-assembly', files);
 */
export async function copyAssemblyDirectory(
  source: AssemblyDirectory,
  target: string,
  files: AssemblyFileSystem,
): Promise<StructuredReason | undefined> {
  for (const file of source.files) {
    const written = await files.createFile(join(target, file.path), file.bytes, file.mode);
    if (!written.ok) {
      return admissionReason(
        'ASSEMBLY_COPY_FAILED',
        SUBJECT,
        `writing ${boundedText(join(target, file.path))} failed with ${written.error.code}: ${boundedText(written.error.detail)}; expected a new file`,
      );
    }
  }
  return undefined;
}

function unreadable(path: string, failure: string): StructuredReason {
  return admissionReason(
    'ASSEMBLY_UNREADABLE',
    SUBJECT,
    `${boundedText(path)} could not be read (${boundedText(failure)}); expected a readable synthesized assembly`,
  );
}
