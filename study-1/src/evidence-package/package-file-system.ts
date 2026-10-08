// The write-once file system port of evidence packages (design §1 principle 7, §5.3). Every
// package, amendment and verification file is written with `writeOnce`, which refuses to
// overwrite, so frozen evidence can never be rewritten in place (BR-RUA-043). Paths are
// normalized POSIX paths relative to the evidence root the adapter is bound to (BR-RUA-035).
// Type-only: it has no runtime part (A-10).

import type { Result } from '../record-contract/primitives.ts';

/** One file as exact bytes, at a normalized POSIX path relative to its package or amendment root. */
export interface PackageFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** What `lstat` says an entry is; symbolic links are never followed. */
export type FsEntryType =
  'file' | 'directory' | 'symlink' | 'fifo' | 'socket' | 'block_device' | 'character_device' | 'unknown';

/** One entry under a listed root: its path relative to that root, its type and its mode bits. */
export interface FsEntry {
  readonly path: string;
  readonly type: FsEntryType;
  /** `stat.mode` as returned by the platform; the low 12 bits are the permission bits. */
  readonly mode: number;
}

/** Why a port call failed; `detail` names the offending path and the expected state. */
export interface FileSystemFailure {
  readonly code: 'NOT_FOUND' | 'ALREADY_EXISTS' | 'INVALID_PATH' | 'IO_ERROR';
  readonly detail: string;
}

/**
 * The evidence file system: list a directory tree, read exact bytes, and create a file once.
 * Every call returns a `Result`; a refusal or an I/O error is a value, never a rejection.
 */
export interface PackageFileSystem {
  /** Every entry below `root` (directories included), sorted by path; `root` itself is not listed. */
  list(root: string): Promise<Result<readonly FsEntry[], FileSystemFailure>>;
  /** The exact stored bytes of one regular file. */
  read(path: string): Promise<Result<Uint8Array, FileSystemFailure>>;
  /** Creates `path` with `bytes`, creating parent directories; `ALREADY_EXISTS` when it exists. */
  writeOnce(path: string, bytes: Uint8Array): Promise<Result<void, FileSystemFailure>>;
}
