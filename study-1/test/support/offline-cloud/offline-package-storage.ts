// One in-memory evidence root behind both evidence ports the runner writes through: the
// write-once PackageFileSystem of package files and the AppendOnlyFile of its JSONL journals. On
// disk they are the same directory tree, so a journal the runner appends to is listed and read
// back with the package files, which is how trial execution reads `runner/runner-journal.jsonl`
// for ingestion. Each port keeps the behavior its conformance suite proves on the real binding
// (test/integration/trial-execution/fakes/offline-package-storage.conformance.integration.test.ts).

import { invalidPathReason } from '../../../src/evidence-package/artifact-classification.ts';
import type {
  FileSystemFailure,
  FsEntry,
  PackageFileSystem,
} from '../../../src/evidence-package/package-file-system.ts';
import { APPEND_FILE_CODES } from '../../../src/event-journal/append-only-file.ts';
import type {
  AppendOnlyFile,
  FileAppendOutcome,
  FileFinalizeOutcome,
} from '../../../src/event-journal/append-only-file.ts';
import { err, ok } from '../../../src/record-contract/primitives.ts';
import type { Result } from '../../../src/record-contract/primitives.ts';

interface StoredFile {
  bytes: Uint8Array;
  finalized: boolean;
}

const FILE_MODE = 0o100644;
const DIRECTORY_MODE = 0o040755;
const LINK_MODE = 0o120777;
const NEWLINE = 0x0a;

export class OfflinePackageStorage implements PackageFileSystem, AppendOnlyFile {
  readonly #files = new Map<string, StoredFile>();
  readonly #links = new Set<string>();
  #listFailures = 0;

  list(root: string): Promise<Result<readonly FsEntry[], FileSystemFailure>> {
    const invalid = checkPath(root);
    if (invalid !== undefined) {
      return Promise.resolve(err(invalid));
    }
    if (this.#listFailures > 0) {
      this.#listFailures -= 1;
      return Promise.resolve(err({ code: 'IO_ERROR', detail: `scripted failure listing ${root}` }));
    }
    const below = (paths: Iterable<string>): readonly string[] =>
      [...paths].filter((path) => path.startsWith(`${root}/`)).map((path) => path.slice(root.length + 1));
    const files = below(this.#files.keys());
    const links = below(this.#links);
    if (files.length + links.length === 0) {
      return Promise.resolve(err({ code: 'NOT_FOUND', detail: `${JSON.stringify(root)} is not a directory` }));
    }
    const directories = new Set([...files, ...links].flatMap((path) => parentsOf(path)));
    const entries: FsEntry[] = [
      ...[...directories].map((path) => ({ path, type: 'directory' as const, mode: DIRECTORY_MODE })),
      ...files.map((path) => ({ path, type: 'file' as const, mode: FILE_MODE })),
      ...links.map((path) => ({ path, type: 'symlink' as const, mode: LINK_MODE })),
    ];
    return Promise.resolve(ok(entries.toSorted((a, b) => (a.path < b.path ? -1 : 1))));
  }

  read(path: string): Promise<Result<Uint8Array, FileSystemFailure>> {
    const invalid = checkPath(path);
    if (invalid !== undefined) {
      return Promise.resolve(err(invalid));
    }
    const file = this.#files.get(path);
    if (file === undefined) {
      return Promise.resolve(
        err({ code: 'NOT_FOUND', detail: `${JSON.stringify(path)} is not a readable regular file` }),
      );
    }
    return Promise.resolve(ok(file.bytes.slice()));
  }

  writeOnce(path: string, bytes: Uint8Array): Promise<Result<void, FileSystemFailure>> {
    const invalid = checkPath(path) ?? this.#directoryConflict(path);
    if (invalid !== undefined) {
      return Promise.resolve(err(invalid));
    }
    if (this.#files.has(path)) {
      return Promise.resolve(err({ code: 'ALREADY_EXISTS', detail: `${JSON.stringify(path)} exists` }));
    }
    this.#files.set(path, { bytes: bytes.slice(), finalized: false });
    return Promise.resolve(ok(undefined));
  }

  append(path: string, bytes: Uint8Array): Promise<FileAppendOutcome> {
    const file = this.#files.get(path) ?? { bytes: new Uint8Array(0), finalized: false };
    if (file.finalized) {
      return Promise.resolve({ kind: 'not_written', code: APPEND_FILE_CODES.finalized });
    }
    const torn = file.bytes.length > 0 && file.bytes[file.bytes.length - 1] !== NEWLINE;
    const payload = torn ? concat(Uint8Array.of(NEWLINE), bytes) : bytes;
    this.#files.set(path, { bytes: concat(file.bytes, payload), finalized: false });
    return Promise.resolve({ kind: 'appended' });
  }

  finalize(path: string): Promise<FileFinalizeOutcome> {
    const file = this.#files.get(path);
    this.#files.set(path, { bytes: file?.bytes ?? new Uint8Array(0), finalized: true });
    return Promise.resolve({ kind: 'finalized' });
  }

  /** Test hook: the next `count` listings fail with IO_ERROR. */
  failNextLists(count: number): void {
    this.#listFailures = count;
  }

  /** Test hook: a symbolic link at `path`, listed as such and never read through. */
  placeSymlink(path: string): void {
    this.#links.add(path);
  }

  /** Test hook: preloads raw bytes, for example a torn last line, without any check. */
  seedRaw(path: string, bytes: Uint8Array): void {
    this.#files.set(path, { bytes: bytes.slice(), finalized: false });
  }

  /** Test hook: every file below `root`, keyed by its path relative to `root`, sorted. */
  filesUnder(root: string): ReadonlyMap<string, Uint8Array> {
    const prefix = `${root}/`;
    return new Map(
      [...this.#files]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, file]) => [path.slice(prefix.length), file.bytes.slice()] as const)
        .toSorted(([a], [b]) => (a < b ? -1 : 1)),
    );
  }

  // A path that is already a directory (a prefix of a stored file) cannot become a file.
  #directoryConflict(path: string): FileSystemFailure | undefined {
    const prefix = `${path}/`;
    const isDirectory = [...this.#files.keys()].some((stored) => stored.startsWith(prefix));
    return isDirectory ? { code: 'ALREADY_EXISTS', detail: `${JSON.stringify(path)} is a directory` } : undefined;
  }
}

function parentsOf(path: string): readonly string[] {
  const segments = path.split('/');
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  return joined;
}

function checkPath(path: string): FileSystemFailure | undefined {
  const invalid = invalidPathReason(path);
  return invalid === undefined ? undefined : { code: 'INVALID_PATH', detail: invalid.detail };
}
