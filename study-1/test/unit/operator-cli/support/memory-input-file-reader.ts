// Named fake of the operator input reader (design §12.2): files held in memory by absolute path.
// An absent path fails with `ENOENT`, as `NodeInputFileReader` does; its conformance test holds the
// two to the same answers over real temporary files.

import type { InputFileReader } from '../../../../src/operator-cli/admit-commands.ts';
import type { Result } from '../../../../src/record-contract/primitives.ts';

export class MemoryInputFileReader implements InputFileReader {
  readonly #files = new Map<string, Uint8Array>();
  /** Every path read, in order. */
  readonly reads: string[] = [];

  /** Holds `bytes` (or the UTF-8 of a string) at `path`. */
  place(path: string, contents: Uint8Array | string): this {
    this.#files.set(path, typeof contents === 'string' ? new TextEncoder().encode(contents) : contents);
    return this;
  }

  readBytes(path: string): Promise<Result<Uint8Array, { readonly code: string; readonly detail: string }>> {
    this.reads.push(path);
    const bytes = this.#files.get(path);
    return Promise.resolve(
      bytes === undefined
        ? { ok: false, error: { code: 'ENOENT', detail: `ENOENT: no such file or directory, open '${path}'` } }
        : { ok: true, value: bytes },
    );
  }
}
