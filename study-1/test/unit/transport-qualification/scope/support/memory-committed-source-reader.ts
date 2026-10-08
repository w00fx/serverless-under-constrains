// Named fake of `CommittedSourceReader`: an in-memory committed tree. It emulates the git
// adapter (`git ls-tree` and `git cat-file blob`): listings are sorted and contain only files
// under the requested roots (none for no root), and an uncommitted path reads as undefined.
// `failWith` scripts an operational failure (the adapter's unreadable revision or object),
// after which every later call of that method, or every read of one path, rejects. Its conformance test compares it with `GitCommittedSourceReader` over a
// real repository.

import type { CommittedSourceReader } from '../../../../../src/transport-qualification/scope/scope-recomputation.ts';

const encoder = new TextEncoder();

export class MemoryCommittedSourceReader implements CommittedSourceReader {
  readonly #files: Map<string, Uint8Array>;
  readonly #reads: string[] = [];
  #failure: { readonly message: string; readonly from: 'listFiles' | 'read'; readonly path?: string } | undefined;

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

  /** Every later call of `from` (only reads of `path`, when given) rejects with an Error carrying `message`. */
  failWith(from: 'listFiles' | 'read', message: string, path?: string): void {
    this.#failure = path === undefined ? { message, from } : { message, from, path };
  }

  listFiles(roots: readonly string[]): Promise<readonly string[]> {
    if (this.#failure?.from === 'listFiles') {
      return Promise.reject(new Error(this.#failure.message));
    }
    const listed = [...this.#files.keys()].filter((path) =>
      roots.some((root) => path === root || path.startsWith(`${root}/`)),
    );
    return Promise.resolve(listed.sort());
  }

  read(path: string): Promise<Uint8Array | undefined> {
    this.#reads.push(path);
    if (this.#failure?.from === 'read' && (this.#failure.path ?? path) === path) {
      return Promise.reject(new Error(this.#failure.message));
    }
    const content = this.#files.get(path);
    return Promise.resolve(content === undefined ? undefined : Uint8Array.from(content));
  }
}
