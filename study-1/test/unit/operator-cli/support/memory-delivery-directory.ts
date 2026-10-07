// Named fake of the local billing delivery directory (design §8.17; production:
// `NodeDeliveryDirectory`): directories held in memory by absolute path, each a listing of entries
// sorted by path as the production reader returns them; an unknown directory fails with `ENOENT`.
// Its conformance test (`node-delivery-directory.integration.test.ts`) holds the two readers to the
// same answers over a real temporary directory.

import type { DeliveryDirectoryReader } from '../../../../src/operator-cli/billing-import-command.ts';
import type { DeliveryEntry } from '../../../../src/operator-cli/billing-delivery.ts';
import type { Result } from '../../../../src/record-contract/primitives.ts';

export class MemoryDeliveryDirectory implements DeliveryDirectoryReader {
  readonly #directories = new Map<string, readonly DeliveryEntry[]>();
  /** Every directory read, in order. */
  readonly reads: string[] = [];

  /** Holds `entries` as the listing of `directory`. */
  place(directory: string, entries: readonly DeliveryEntry[]): this {
    this.#directories.set(
      directory,
      entries.toSorted((a, b) => (a.path < b.path ? -1 : 1)),
    );
    return this;
  }

  read(
    directory: string,
  ): Promise<Result<readonly DeliveryEntry[], { readonly code: string; readonly detail: string }>> {
    this.reads.push(directory);
    const entries = this.#directories.get(directory);
    return Promise.resolve(
      entries === undefined
        ? { ok: false, error: { code: 'ENOENT', detail: `ENOENT: no such file or directory, scandir '${directory}'` } }
        : { ok: true, value: entries },
    );
  }
}
