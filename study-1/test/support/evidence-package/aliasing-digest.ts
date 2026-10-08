// A byte digest that gives chosen byte strings a chosen digest and every other byte string its real
// SHA-256. Real SHA-256 makes an amendment cycle impossible to build (each index would have to name
// its own descendant's digest), so the AC-RUA-022 `cycle` fixture aliases two amendment indexes to
// digests that name each other. Only the aliased byte strings differ from production.

import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';

export class AliasingDigest {
  readonly #aliases = new Map<string, Sha256Hex>();

  /** Makes `digest(bytes)` return `alias` from now on. */
  alias(bytes: Uint8Array, alias: Sha256Hex): void {
    this.#aliases.set(key(bytes), alias);
  }

  /** The alias of `bytes`, or their real SHA-256. Bound, so it can be passed as a function. */
  readonly digest = (bytes: Uint8Array): Sha256Hex => this.#aliases.get(key(bytes)) ?? sha256Hex(bytes);
}

function key(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
