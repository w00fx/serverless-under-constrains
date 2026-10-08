// A named fake of the schema registry's filesystem port. Directory listings come back in the
// order the test wrote them (not sorted), which is how ext4 behaves and how the registry's
// own ordering is proven independent of the host filesystem.

import type { SchemaFileSystem } from '../../../src/record-contract/schema-registry.ts';

/**
 * The schema registry's filesystem port in memory, listing names in insertion order.
 *
 * @example
 * const fileSystem = new InMemorySchemaFileSystem().writeFile('/c/group-a/payment.schema.json', '{}');
 * listSchemaFiles({ schemaRoot: '/c', fileSystem });
 */
export class InMemorySchemaFileSystem implements SchemaFileSystem {
  readonly #files = new Map<string, Uint8Array>();
  readonly #directories = new Map<string, string[]>();
  readonly #reads: string[] = [];

  /** Adds a file; its parent directory lists it after every name added before it. */
  writeFile(path: string, contents: string | Uint8Array): this {
    const slash = path.lastIndexOf('/');
    const directory = path.slice(0, slash);
    const listed = this.#directories.get(directory) ?? [];
    this.#directories.set(
      directory,
      listed.includes(path.slice(slash + 1)) ? listed : [...listed, path.slice(slash + 1)],
    );
    this.#files.set(path, typeof contents === 'string' ? new TextEncoder().encode(contents) : contents);
    return this;
  }

  /** Removes the bytes of a file but keeps it listed, as a file deleted mid-listing looks. */
  forgetContents(path: string): this {
    this.#files.delete(path);
    return this;
  }

  /** Names in `path` in the order they were written, or undefined for an unknown directory. */
  readonly listDirectory = (path: string): readonly string[] | undefined => {
    const listed = this.#directories.get(path);
    return listed === undefined ? undefined : [...listed];
  };

  /** The bytes of `path`, or undefined; every call is recorded for `readPaths()`. */
  readonly readFile = (path: string): Uint8Array | undefined => {
    this.#reads.push(path);
    return this.#files.get(path);
  };

  /** Every path passed to `readFile`, in call order. */
  readPaths(): readonly string[] {
    return [...this.#reads];
  }
}
