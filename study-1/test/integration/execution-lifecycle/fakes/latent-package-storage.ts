// An evidence root whose file creations take time: every `writeOnce` waits `latencyMs` on the
// injected sleeper before it reaches the wrapped storage, as a slow disk or a network file system
// would. Offline, collecting and freezing a trial otherwise take no virtual time, so nothing could
// happen between a trial's last observation and the next trial's start; with this latency the
// active-time deadline can fall inside a trial's freeze (AC-RUA-049, the deadline between trials).

import type {
  AppendOnlyFile,
  FileAppendOutcome,
  FileFinalizeOutcome,
} from '../../../../src/event-journal/append-only-file.ts';
import type {
  FileSystemFailure,
  FsEntry,
  PackageFileSystem,
} from '../../../../src/evidence-package/package-file-system.ts';
import type { Result, Sleeper } from '../../../../src/record-contract/primitives.ts';

/** The storage a latent root wraps: package files and journals on one medium. */
export type EvidenceStorage = PackageFileSystem & AppendOnlyFile;

/**
 * Delays every file creation by a fixed latency; reads, lists and appends pass straight through.
 *
 * @example
 * const slow = new LatentPackageStorage(cloud.storage, cloud.time, 2_000);
 * await slow.writeOnce(path, bytes); // completes 2 s of virtual time later
 */
export class LatentPackageStorage implements PackageFileSystem, AppendOnlyFile {
  readonly #inner: EvidenceStorage;
  readonly #sleeper: Sleeper;
  readonly #latencyMs: number;
  #writes = 0;

  constructor(inner: EvidenceStorage, sleeper: Sleeper, latencyMs: number) {
    this.#inner = inner;
    this.#sleeper = sleeper;
    this.#latencyMs = latencyMs;
  }

  /** How many file creations were delayed. */
  writes(): number {
    return this.#writes;
  }

  list(root: string): Promise<Result<readonly FsEntry[], FileSystemFailure>> {
    return this.#inner.list(root);
  }

  read(path: string): Promise<Result<Uint8Array, FileSystemFailure>> {
    return this.#inner.read(path);
  }

  async writeOnce(path: string, bytes: Uint8Array): Promise<Result<void, FileSystemFailure>> {
    this.#writes += 1;
    await this.#sleeper.sleep(this.#latencyMs);
    return this.#inner.writeOnce(path, bytes);
  }

  append(path: string, bytes: Uint8Array): Promise<FileAppendOutcome> {
    return this.#inner.append(path, bytes);
  }

  finalize(path: string): Promise<FileFinalizeOutcome> {
    return this.#inner.finalize(path);
  }
}
