// The file-system port of the deployment assembly (design §5.3 `CopyFileSystem`, §9.8 S1, D1-D3).
// It works on local absolute directories outside the evidence root: the synthesis staging
// directory, the frozen package copy and the temporary deploy copy. `createFile` never overwrites
// and sets the exact permission bits, because the inventory records each file's mode and a
// byte-identical copy must reproduce it (BR-RUA-042). Every call returns a `Result`; a refusal or
// an I/O error is a value, never a rejection. Type-only: it has no runtime part (A-10).

import type { Result } from '../record-contract/primitives.ts';
import type { FileSystemFailure, FsEntry } from '../evidence-package/package-file-system.ts';

/**
 * Local directories of the deployment assembly, addressed by absolute paths.
 */
export interface AssemblyFileSystem {
  /** Every entry below `directory` (directories included), sorted by relative path; `NOT_FOUND` when absent. */
  list(directory: string): Promise<Result<readonly FsEntry[], FileSystemFailure>>;
  /** The exact bytes of one regular file; a symbolic link is refused. */
  read(path: string): Promise<Result<Uint8Array, FileSystemFailure>>;
  /** Creates `path` (and its parent directories) with `bytes` and exactly the permission bits `mode`. */
  createFile(path: string, bytes: Uint8Array, mode: number): Promise<Result<void, FileSystemFailure>>;
}
