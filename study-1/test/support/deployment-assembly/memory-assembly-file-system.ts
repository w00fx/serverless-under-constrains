// In-memory emulator of the AssemblyFileSystem port. It reproduces the behavior of the local binding
// `NodeAssemblyFileSystem` that the shared conformance suite proves on both: absolute paths,
// `createFile` creates parent directories, refuses an existing path and keeps exactly the given
// permission bits, `list` returns every entry below a directory sorted by relative path
// (directories included, the directory itself excluded) and `NOT_FOUND` for an absent one, and
// `read` returns the exact bytes of a regular file only (a link or directory is an I/O error).
//
// Test hooks, outside the port:
// - `placeSpecial(path, type)` adds a non-regular entry such as a symbolic link or a FIFO;
// - `failList(directory)`, `failRead(path)` and `failCreate(path)` make every later call on that
//   path fail with `IO_ERROR`;
// - `removeFile(path)` deletes an entry (the FakeCommandRunner releases its lock files with it);
// - `corrupt(path)` flips every bit of the first stored byte;
// - `setMode(path, mode)` changes the permission bits of a stored file.

import { err, ok } from '../../../src/record-contract/primitives.ts';
import type { Result } from '../../../src/record-contract/primitives.ts';
import type { FileSystemFailure, FsEntry, FsEntryType } from '../../../src/evidence-package/package-file-system.ts';
import type { AssemblyFileSystem } from '../../../src/deployment-assembly/assembly-file-system.ts';

interface StoredEntry {
  readonly type: FsEntryType;
  readonly mode: number;
  readonly bytes?: Uint8Array;
}

const REGULAR_FILE_TYPE_BITS = 0o100000;
const DIRECTORY_MODE = 0o040755;
const SPECIAL_MODE = 0o120777;
const PERMISSION_BITS = 0o7777;

export class MemoryAssemblyFileSystem implements AssemblyFileSystem {
  readonly #entries = new Map<string, StoredEntry>([['/', { type: 'directory', mode: DIRECTORY_MODE }]]);
  readonly #failing = new Set<string>();

  list(directory: string): Promise<Result<readonly FsEntry[], FileSystemFailure>> {
    const failure = this.#scriptedFailure('list', directory);
    if (failure !== undefined) {
      return Promise.resolve(err(failure));
    }
    const entry = this.#entries.get(directory);
    if (entry?.type !== 'directory') {
      return Promise.resolve(err(missingOrNotDirectory(directory, entry)));
    }
    const prefix = directory.endsWith('/') ? directory : `${directory}/`;
    const entries = [...this.#entries]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, stored]) => ({ path: path.slice(prefix.length), type: stored.type, mode: stored.mode }))
      .toSorted((a, b) => (a.path < b.path ? -1 : 1));
    return Promise.resolve(ok(entries));
  }

  read(path: string): Promise<Result<Uint8Array, FileSystemFailure>> {
    const failure = this.#scriptedFailure('read', path);
    const entry = this.#entries.get(path);
    if (failure !== undefined || entry === undefined) {
      return Promise.resolve(err(failure ?? { code: 'NOT_FOUND', detail: `${JSON.stringify(path)}: ENOENT` }));
    }
    if (entry.bytes === undefined) {
      return Promise.resolve(err({ code: 'IO_ERROR', detail: `${JSON.stringify(path)} is a ${entry.type}` }));
    }
    return Promise.resolve(ok(entry.bytes.slice()));
  }

  createFile(path: string, bytes: Uint8Array, mode: number): Promise<Result<void, FileSystemFailure>> {
    const failure = this.#scriptedFailure('create', path);
    if (failure !== undefined) {
      return Promise.resolve(err(failure));
    }
    if (this.#entries.has(path)) {
      return Promise.resolve(err({ code: 'ALREADY_EXISTS', detail: `${JSON.stringify(path)}: EEXIST` }));
    }
    this.#placeParents(path);
    this.#entries.set(path, {
      type: 'file',
      mode: REGULAR_FILE_TYPE_BITS | (mode & PERMISSION_BITS),
      bytes: bytes.slice(),
    });
    return Promise.resolve(ok(undefined));
  }

  /** Adds a non-regular entry (with its parent directories) at `path`. */
  placeSpecial(path: string, type: Exclude<FsEntryType, 'file' | 'directory'>): void {
    this.#placeParents(path);
    this.#entries.set(path, { type, mode: SPECIAL_MODE });
  }

  /** Makes every later `list`, `read` or `createFile` of `path` fail with IO_ERROR. */
  failList(path: string): void {
    this.#failing.add(`list ${path}`);
  }

  failRead(path: string): void {
    this.#failing.add(`read ${path}`);
  }

  failCreate(path: string): void {
    this.#failing.add(`create ${path}`);
  }

  /** Removes the entry at `path`, as a CLI releasing its lock file does; absent is fine. */
  removeFile(path: string): Promise<void> {
    this.#entries.delete(path);
    return Promise.resolve();
  }

  /** Flips every bit of the first byte of the file at `path`. */
  corrupt(path: string): void {
    const entry = this.#storedFile(path);
    const bytes = entry.bytes.slice();
    const first = bytes[0];
    if (first === undefined) {
      throw new Error(`${JSON.stringify(path)} is empty; expected a stored file with a byte to flip`);
    }
    bytes[0] = first ^ 0xff;
    this.#entries.set(path, { ...entry, bytes });
  }

  /** Sets the permission bits of the file at `path`. */
  setMode(path: string, mode: number): void {
    const entry = this.#storedFile(path);
    this.#entries.set(path, { ...entry, mode: REGULAR_FILE_TYPE_BITS | (mode & PERMISSION_BITS) });
  }

  #storedFile(path: string): StoredEntry & { readonly bytes: Uint8Array } {
    const entry = this.#entries.get(path);
    if (entry?.bytes === undefined) {
      throw new Error(`${JSON.stringify(path)} is not a stored file; expected a file created with createFile`);
    }
    return { ...entry, bytes: entry.bytes };
  }

  #scriptedFailure(operation: string, path: string): FileSystemFailure | undefined {
    return this.#failing.has(`${operation} ${path}`)
      ? { code: 'IO_ERROR', detail: `scripted ${operation} failure at ${JSON.stringify(path)}` }
      : undefined;
  }

  #placeParents(path: string): void {
    const segments = path.split('/').slice(1, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      const parent = `/${segments.slice(0, index).join('/')}`;
      if (!this.#entries.has(parent)) {
        this.#entries.set(parent, { type: 'directory', mode: DIRECTORY_MODE });
      }
    }
  }
}

function missingOrNotDirectory(directory: string, entry: StoredEntry | undefined): FileSystemFailure {
  return entry === undefined
    ? { code: 'NOT_FOUND', detail: `${JSON.stringify(directory)}: ENOENT` }
    : { code: 'IO_ERROR', detail: `${JSON.stringify(directory)}: ENOTDIR` };
}
