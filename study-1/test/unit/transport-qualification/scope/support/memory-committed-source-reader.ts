// Named fake of `CommittedSourceReader`: an in-memory committed tree. It emulates the git
// adapter (`git ls-tree -r` and `git cat-file blob <rev>:./<path>`): listings are sorted and
// contain only files under the requested roots, and an uncommitted path reads as undefined.
// Its conformance test compares it with `GitCommittedSourceReader` over a real repository.

import type { CommittedSourceReader } from '../../../../../src/transport-qualification/scope/scope-recomputation.ts';

const encoder = new TextEncoder();

export class MemoryCommittedSourceReader implements CommittedSourceReader {
  readonly #files: Map<string, Uint8Array>;
  readonly #reads: string[] = [];

  constructor(files: Readonly<Record<string, string | Uint8Array>> = {}) {
    this.#files = new Map(
      Object.entries(files).map(([path, content]) => [
        path,
        typeof content === 'string' ? encoder.encode(content) : content,
      ]),
    );
  }

  /** Commits (adds or replaces) one file. */
  commit(path: string, content: string | Uint8Array): void {
    this.#files.set(path, typeof content === 'string' ? encoder.encode(content) : content);
  }

  /** Removes one file from the committed tree. */
  remove(path: string): void {
    this.#files.delete(path);
  }

  /** Every path read so far, in call order. */
  reads(): readonly string[] {
    return [...this.#reads];
  }

  listFiles(roots: readonly string[]): Promise<readonly string[]> {
    const listed = [...this.#files.keys()].filter((path) =>
      roots.some((root) => path === root || path.startsWith(`${root}/`)),
    );
    return Promise.resolve(listed.sort());
  }

  read(path: string): Promise<Uint8Array | undefined> {
    this.#reads.push(path);
    const content = this.#files.get(path);
    return Promise.resolve(content === undefined ? undefined : Uint8Array.from(content));
  }
}
