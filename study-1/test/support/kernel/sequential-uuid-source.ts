// Deterministic UUIDv4 source (design §12.2). Ids are canonical lowercase version-4 UUIDs,
// so they pass every BR-RUA-033 identifier check, and `repeatNext()` forces a collision to
// exercise identity-integrity paths (INV-RUA-001).

import type { Uuid4, UuidSource } from '../../../src/record-contract/primitives.ts';

const NAMESPACE_PATTERN = /^[0-9a-f]{8}$/;

export class SequentialUuidSource implements UuidSource {
  readonly #namespace: string;
  #counter = 0;
  #last: Uuid4 | undefined;
  #repeatPending = false;

  /** `namespace` (8 lowercase hex digits) keeps ids of different sources distinct. */
  constructor(namespace = '00000000') {
    if (!NAMESPACE_PATTERN.test(namespace)) {
      throw new RangeError(`namespace ${JSON.stringify(namespace)}; expected 8 lowercase hex digits`);
    }
    this.#namespace = namespace;
  }

  next(): Uuid4 {
    if (this.#repeatPending && this.#last !== undefined) {
      this.#repeatPending = false;
      return this.#last;
    }
    this.#counter += 1;
    const id = `${this.#namespace}-0000-4000-8000-${this.#counter.toString(16).padStart(12, '0')}` as Uuid4;
    this.#last = id;
    return id;
  }

  /** The next call to `next()` returns the previously issued id again. */
  repeatNext(): void {
    if (this.#last === undefined) {
      throw new Error('repeatNext() before any id was issued; expected next() to have been called first');
    }
    this.#repeatPending = true;
  }

  issuedCount(): number {
    return this.#counter;
  }
}
