// Local binding of the AssemblyFileSystem port over absolute directories.
//
// Node facts this relies on (https://nodejs.org/docs/latest-v24.x/api/fs.html):
// - `lstat` describes a symbolic link itself, never its target, so a link is listed as a link and
//   the listing never leaves the directory;
// - `O_NOFOLLOW` makes `open` fail on a symbolic link instead of reading its target, and
//   `O_NONBLOCK` keeps `open` from waiting on a FIFO swapped in for a listed file, which would
//   then read as empty, so the opened handle must also `fstat` as a regular file;
// - flag `wx` creates the file and fails with EEXIST when the path exists, so a copy never
//   overwrites; the creation mode is filtered by the process umask, so `filehandle.chmod` sets the
//   exact permission bits afterwards, which the inventory compares (BR-RUA-042);
// - `filehandle.sync()` is fsync(2).

import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { boundedJsonText, boundedText } from '../../record-contract/json-value.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import type { Result } from '../../record-contract/primitives.ts';
import type { FileSystemFailure, FsEntry, FsEntryType } from '../../evidence-package/package-file-system.ts';
import type { AssemblyFileSystem } from '../assembly-file-system.ts';

/**
 * The deployment assembly's directories on local disk.
 *
 * @example
 * const files = new NodeAssemblyFileSystem();
 * await files.createFile('/work/.deploy-staging/<id>/manifest.json', bytes, 0o644);
 */
export class NodeAssemblyFileSystem implements AssemblyFileSystem {
  /**
   * Every entry below `directory`, depth first, sorted by relative path; links are listed, never followed.
   *
   * @example
   * await files.list('/work/staging/cdk.out'); // { ok: true, value: [{ path: 'manifest.json', type: 'file', mode }, ...] }
   */
  async list(directory: string): Promise<Result<readonly FsEntry[], FileSystemFailure>> {
    const entries: FsEntry[] = [];
    const pending: string[] = [''];
    for (let relative = pending.pop(); relative !== undefined; relative = pending.pop()) {
      const listed = await listDirectory(directory, relative);
      if (!listed.ok) {
        return listed;
      }
      collectEntries(listed.value, entries, pending);
    }
    return ok(entries.toSorted((a, b) => (a.path < b.path ? -1 : 1)));
  }

  /**
   * The exact bytes of one regular file; a symbolic link is refused.
   *
   * @example
   * await files.read('/work/staging/cdk.out/manifest.json');
   */
  async read(path: string): Promise<Result<Uint8Array, FileSystemFailure>> {
    return attempt(async () => {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        // A FIFO opened non-blocking reads as empty and a directory fails late: refuse both here.
        const stats = await handle.stat();
        if (!stats.isFile()) {
          throw Object.assign(new Error(`a ${entryType(stats)}, not a regular file`), { code: 'EFTYPE' });
        }
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    }, path);
  }

  /**
   * Creates `path` with `bytes` and exactly the permission bits `mode`; `ALREADY_EXISTS` when it exists.
   *
   * @example
   * await files.createFile('/work/copy/asset.abc/index.mjs', bytes, 0o644);
   */
  async createFile(path: string, bytes: Uint8Array, mode: number): Promise<Result<void, FileSystemFailure>> {
    return attempt(async () => {
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, 'wx', mode);
      try {
        await handle.writeFile(bytes);
        await handle.chmod(mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }, path);
  }
}

async function listDirectory(base: string, relative: string): Promise<Result<readonly FsEntry[], FileSystemFailure>> {
  const names = await attempt(() => readdir(join(base, relative)), join(base, relative));
  if (!names.ok) {
    return names;
  }
  const entries: FsEntry[] = [];
  for (const name of names.value) {
    const path = relative === '' ? name : `${relative}/${name}`;
    const stats = await attempt(() => lstat(join(base, path)), join(base, path));
    if (!stats.ok) {
      return stats;
    }
    entries.push({ path, type: entryType(stats.value), mode: stats.value.mode });
  }
  return ok(entries);
}

// One push per entry: a spread push throws RangeError past the engine's argument limit (A-05).
function collectEntries(listed: readonly FsEntry[], entries: FsEntry[], pending: string[]): void {
  for (const entry of listed) {
    entries.push(entry);
    if (entry.type === 'directory') {
      pending.push(entry.path);
    }
  }
}

async function attempt<T>(operation: () => Promise<T>, path: string): Promise<Result<T, FileSystemFailure>> {
  try {
    return ok(await operation());
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    return err({
      code: failureCode(code),
      detail: `${boundedJsonText(path)}: ${String(code)} ${boundedText((error as Error).message)}`,
    });
  }
}

function failureCode(code: string | undefined): FileSystemFailure['code'] {
  if (code === 'ENOENT') {
    return 'NOT_FOUND';
  }
  return code === 'EEXIST' ? 'ALREADY_EXISTS' : 'IO_ERROR';
}

function entryType(stats: Stats): FsEntryType {
  const checks: readonly (readonly [boolean, FsEntryType])[] = [
    [stats.isFile(), 'file'],
    [stats.isDirectory(), 'directory'],
    [stats.isSymbolicLink(), 'symlink'],
    [stats.isFIFO(), 'fifo'],
    [stats.isSocket(), 'socket'],
    [stats.isBlockDevice(), 'block_device'],
    [stats.isCharacterDevice(), 'character_device'],
  ];
  return checks.find(([matches]) => matches)?.[1] ?? 'unknown';
}
