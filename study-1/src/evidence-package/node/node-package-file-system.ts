// Local file-system binding of the PackageFileSystem port, rooted at one evidence directory.
//
// Node facts this relies on (https://nodejs.org/docs/latest-v24.x/api/fs.html):
// - `lstat` describes a symbolic link itself, never its target, so a link is listed as a link;
// - flag `wx` creates the file and fails with EEXIST when the path exists, atomically, so a
//   frozen file is never overwritten (BR-RUA-043);
// - `O_NOFOLLOW` makes `open` fail on a symbolic link instead of reading its target, and
//   `O_NONBLOCK` keeps `open` from waiting on a FIFO swapped in for a listed file;
// - `filehandle.sync()` is fsync(2): the bytes reach stable storage before `writeOnce` returns.
// Every port path is checked as a normalized relative POSIX path (BR-RUA-035) before it is joined
// to the root, so `..` or an absolute path can never leave the evidence directory.

import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { boundedJsonText, boundedText } from '../../record-contract/json-value.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import type { Result } from '../../record-contract/primitives.ts';
import { invalidPathReason } from '../artifact-classification.ts';
import type { FileSystemFailure, FsEntry, FsEntryType, PackageFileSystem } from '../package-file-system.ts';

/**
 * The evidence file system on local disk.
 *
 * @example
 * const fs = new NodePackageFileSystem('/work/evidence');
 * await fs.writeOnce('runs/<id>/package-index.json', bytes); // { ok: true } once, ALREADY_EXISTS after
 */
export class NodePackageFileSystem implements PackageFileSystem {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  /**
   * Every entry below `root`, depth first, sorted by path; symbolic links are listed, never followed.
   *
   * @example
   * await fs.list('runs/<id>'); // { ok: true, value: [{ path: 'admission', type: 'directory', mode }, ...] }
   */
  async list(root: string): Promise<Result<readonly FsEntry[], FileSystemFailure>> {
    const base = this.#resolve(root);
    if (!base.ok) {
      return base;
    }
    const entries: FsEntry[] = [];
    const pending: string[] = [''];
    for (let relative = pending.pop(); relative !== undefined; relative = pending.pop()) {
      const listed = await listDirectory(base.value, relative);
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
   * await fs.read('runs/<id>/package-index.json');
   */
  async read(path: string): Promise<Result<Uint8Array, FileSystemFailure>> {
    const target = this.#resolve(path);
    if (!target.ok) {
      return target;
    }
    return attempt(async () => {
      const handle = await open(target.value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    }, path);
  }

  /**
   * Creates `path` with `bytes` and fsyncs it; `ALREADY_EXISTS` when the path exists.
   *
   * @example
   * await fs.writeOnce('runs/<id>/package-index.json', bytes);
   */
  async writeOnce(path: string, bytes: Uint8Array): Promise<Result<void, FileSystemFailure>> {
    const target = this.#resolve(path);
    if (!target.ok) {
      return target;
    }
    return attempt(async () => {
      await mkdir(dirname(target.value), { recursive: true });
      const handle = await open(target.value, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }, path);
  }

  #resolve(path: string): Result<string, FileSystemFailure> {
    const invalid = invalidPathReason(path);
    return invalid === undefined ? ok(join(this.#root, path)) : err({ code: 'INVALID_PATH', detail: invalid.detail });
  }
}

async function listDirectory(base: string, relative: string): Promise<Result<readonly FsEntry[], FileSystemFailure>> {
  const names = await attempt(() => readdir(join(base, relative)), relative);
  if (!names.ok) {
    return names;
  }
  const entries: FsEntry[] = [];
  for (const name of names.value) {
    const path = relative === '' ? name : `${relative}/${name}`;
    const stats = await attempt(() => lstat(join(base, path)), path);
    if (!stats.ok) {
      return stats;
    }
    entries.push({ path, type: entryType(stats.value), mode: stats.value.mode });
  }
  return ok(entries);
}

// One push per entry: a spread push throws RangeError past the engine's argument limit, which a
// directory with enough entries reaches (A-05 totality).
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
