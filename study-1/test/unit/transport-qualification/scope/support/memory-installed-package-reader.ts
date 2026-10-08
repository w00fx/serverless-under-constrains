// Named fake of `InstalledPackageReader`: an in-memory `node_modules`. It emulates the
// `NodeModulesPackageReader` adapter: an installed package reads as its version and any other
// install path reads as undefined (not installed). `failWith` scripts an operational failure
// (the adapter's unreadable or malformed manifest) for one install path or for every read. Its
// conformance test compares it with `NodeModulesPackageReader` over a real directory tree.

import type { InstalledPackageReader } from '../../../../../src/transport-qualification/scope/scope-recomputation.ts';

export class MemoryInstalledPackageReader implements InstalledPackageReader {
  readonly #versions: Map<string, string>;
  readonly #reads: string[] = [];
  #failure: { readonly message: string; readonly installPath?: string } | undefined;

  constructor(versions: Readonly<Record<string, string>> = {}) {
    this.#versions = new Map(Object.entries(versions));
  }

  /** Installs (adds or replaces) the package at one install path. */
  install(installPath: string, version: string): void {
    this.#versions.set(installPath, version);
  }

  /** Removes the package at one install path. */
  uninstall(installPath: string): void {
    this.#versions.delete(installPath);
  }

  /** Every install path read so far, in call order. */
  reads(): readonly string[] {
    return [...this.#reads];
  }

  /** Every later read (only reads of `installPath`, when given) rejects with an Error carrying `message`. */
  failWith(message: string, installPath?: string): void {
    this.#failure = installPath === undefined ? { message } : { message, installPath };
  }

  installedVersion(installPath: string): Promise<string | undefined> {
    this.#reads.push(installPath);
    if (this.#failure !== undefined && (this.#failure.installPath ?? installPath) === installPath) {
      return Promise.reject(new Error(this.#failure.message));
    }
    return Promise.resolve(this.#versions.get(installPath));
  }
}
