// In-memory emulator of the PackageFileSystem port. It reproduces the behavior of the local binding
// `NodePackageFileSystem` that the shared conformance suite proves on both: paths are normalized
// relative POSIX paths, `writeOnce` creates parent directories and refuses an existing path,
// `list` returns every entry below a root sorted by path (directories included, the root
// excluded), and `read` returns exact bytes of a regular file only.
//
// Test hooks, outside the port:
// - `corrupt(path, offset)` flips every bit of one stored byte (an altered byte, AC-RUA-022);
// - `placeSpecial(path, type)` adds a non-regular entry such as a symbolic link;
// - `failReads(path, code)` makes every later read of `path` fail with that code;
// - `failLists(root, code)` makes every later listing of `root` fail with that code.

import { err, ok } from '../../../src/record-contract/primitives.ts';
import type { Result } from '../../../src/record-contract/primitives.ts';
import { invalidPathReason } from '../../../src/evidence-package/artifact-classification.ts';
import type {
  FileSystemFailure,
  FsEntry,
  FsEntryType,
  PackageFileSystem,
} from '../../../src/evidence-package/package-file-system.ts';

interface StoredEntry {
  readonly type: FsEntryType;
  readonly mode: number;
  readonly bytes?: Uint8Array;
}

const FILE_MODE = 0o100644;
const DIRECTORY_MODE = 0o040755;
const SPECIAL_MODE = 0o120777;

export class MemoryPackageFileSystem implements PackageFileSystem {
  readonly #entries = new Map<string, StoredEntry>();
  readonly #readFailures = new Map<string, FileSystemFailure['code']>();
  readonly #listFailures = new Map<string, FileSystemFailure['code']>();

  list(root: string): Promise<Result<readonly FsEntry[], FileSystemFailure>> {
    const invalid = checkPath(root);
    const failure = this.#listFailures.get(root);
    if (invalid !== undefined || failure !== undefined) {
      return Promise.resolve(
        err(invalid ?? { code: failure ?? 'IO_ERROR', detail: `scripted failure listing ${root}` }),
      );
    }
    if (this.#entries.get(root)?.type !== 'directory') {
      return Promise.resolve(err({ code: 'NOT_FOUND', detail: `${JSON.stringify(root)} is not a directory` }));
    }
    const prefix = `${root}/`;
    const entries = [...this.#entries]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, entry]) => ({ path: path.slice(prefix.length), type: entry.type, mode: entry.mode }))
      .toSorted((a, b) => (a.path < b.path ? -1 : 1));
    return Promise.resolve(ok(entries));
  }

  read(path: string): Promise<Result<Uint8Array, FileSystemFailure>> {
    const invalid = checkPath(path);
    const failure = this.#readFailures.get(path);
    const entry = this.#entries.get(path);
    if (invalid !== undefined || failure !== undefined) {
      return Promise.resolve(
        err(invalid ?? { code: failure ?? 'IO_ERROR', detail: `scripted failure reading ${path}` }),
      );
    }
    if (entry?.bytes === undefined) {
      const code = entry === undefined ? 'NOT_FOUND' : 'IO_ERROR';
      return Promise.resolve(err({ code, detail: `${JSON.stringify(path)} is not a readable regular file` }));
    }
    return Promise.resolve(ok(entry.bytes.slice()));
  }

  writeOnce(path: string, bytes: Uint8Array): Promise<Result<void, FileSystemFailure>> {
    const invalid = checkPath(path);
    if (invalid !== undefined) {
      return Promise.resolve(err(invalid));
    }
    if (this.#entries.has(path)) {
      return Promise.resolve(err({ code: 'ALREADY_EXISTS', detail: `${JSON.stringify(path)} exists` }));
    }
    this.#createParents(path);
    this.#entries.set(path, { type: 'file', mode: FILE_MODE, bytes: bytes.slice() });
    return Promise.resolve(ok(undefined));
  }

  /** Flips every bit of the byte at `offset` of a stored file. */
  corrupt(path: string, offset: number): void {
    const bytes = this.#entries.get(path)?.bytes;
    if (bytes === undefined || offset < 0 || offset >= bytes.length) {
      throw new Error(
        `cannot corrupt ${JSON.stringify(path)} at ${String(offset)}; expected a stored file and an offset inside it`,
      );
    }
    const altered = bytes.slice();
    altered[offset] = (altered[offset] ?? 0) ^ 0xff;
    this.#entries.set(path, { type: 'file', mode: FILE_MODE, bytes: altered });
  }

  /** Adds a non-regular entry, such as a symbolic link, at `path`. */
  placeSpecial(path: string, type: Exclude<FsEntryType, 'file' | 'directory'>): void {
    this.#createParents(path);
    this.#entries.set(path, { type, mode: SPECIAL_MODE });
  }

  /** Makes every later read of `path` fail with `code`. */
  failReads(path: string, code: FileSystemFailure['code']): void {
    this.#readFailures.set(path, code);
  }

  /** Makes every later listing of `root` fail with `code`. */
  failLists(root: string, code: FileSystemFailure['code']): void {
    this.#listFailures.set(root, code);
  }

  #createParents(path: string): void {
    const segments = path.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const parent = segments.slice(0, length).join('/');
      if (!this.#entries.has(parent)) {
        this.#entries.set(parent, { type: 'directory', mode: DIRECTORY_MODE });
      }
    }
  }
}

function checkPath(path: string): FileSystemFailure | undefined {
  const invalid = invalidPathReason(path);
  return invalid === undefined ? undefined : { code: 'INVALID_PATH', detail: invalid.detail };
}
