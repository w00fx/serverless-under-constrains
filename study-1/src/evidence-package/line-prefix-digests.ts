// Line-boundary prefix digests of an append-only JSONL journal (Owner amendment A-15, decision 80;
// BR-RUA-044 prefix model). A record frozen while a journal is still open cites the journal with the
// digest it had then: the digest of a prefix of the final bytes that ends right after a `\n`. Only
// such a prefix counts: a line still being appended is not yet an event (prefix-checkpoint.ts uses
// the same rule), and the empty prefix ends no line, so it never counts.
//
// The prefixes are digested lazily and in increasing length, each at most once, so a verification
// that resolves many references pays for each prefix once, and a lookup that fails scans the rest
// of the journal once. The scan reads the bytes with `indexOf`, keeps no array of line ends and
// never throws, so a huge or newline-free journal is fine (A-05).

import type { ByteDigest } from './package-integrity.ts';

const NEWLINE = 0x0a;

/**
 * The newline-terminated prefixes of one journal, looked up by digest.
 *
 * @example
 * const prefixes = new LinePrefixDigests(journalBytes, sha256Hex);
 * prefixes.prefixWithDigest(frozenDigest); // the prefix's bytes, or undefined when none has that digest
 */
export class LinePrefixDigests {
  readonly #bytes: Uint8Array;
  readonly #digest: ByteDigest;
  /** Every prefix digested so far, by digest. */
  readonly #lengths = new Map<string, number>();
  /** The end of the longest prefix digested so far; the scan resumes here. */
  #scanned = 0;

  constructor(bytes: Uint8Array, digest: ByteDigest) {
    this.#bytes = bytes;
    this.#digest = digest;
  }

  /** The line-boundary prefix whose digest is `wanted`, or `undefined`. */
  prefixWithDigest(wanted: string): Uint8Array | undefined {
    const length = this.#lengthOf(wanted);
    return length === undefined ? undefined : this.#bytes.subarray(0, length);
  }

  #lengthOf(wanted: string): number | undefined {
    const known = this.#lengths.get(wanted);
    if (known !== undefined) {
      return known;
    }
    for (let end = this.#nextLineEnd(); end > 0; end = this.#nextLineEnd()) {
      this.#scanned = end;
      const prefixDigest: string = this.#digest(this.#bytes.subarray(0, end));
      this.#lengths.set(prefixDigest, end);
      if (prefixDigest === wanted) {
        return end;
      }
    }
    return undefined;
  }

  /** The end (one past the `\n`) of the next unscanned line, or 0 when no complete line remains. */
  #nextLineEnd(): number {
    return this.#bytes.indexOf(NEWLINE, this.#scanned) + 1;
  }
}
