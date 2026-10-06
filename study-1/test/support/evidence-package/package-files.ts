// Small builders of package files for the evidence-package tests.

import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';

const encoder = new TextEncoder();

/**
 * A file holding the UTF-8 bytes of `text`.
 *
 * @example
 * textFile('admission/execution-manifest.json', '{}\n');
 */
export function textFile(path: string, text: string): PackageFile {
  return { path, bytes: encoder.encode(text) };
}

/**
 * The UTF-8 bytes of `text`.
 *
 * @example
 * utf8('{"a":1}');
 */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * The text of a builder failure's codes, for compact assertions.
 *
 * @example
 * reasonCodes([{ code: 'A', subject: 's', detail: 'd' }]); // ['A']
 */
export function reasonCodes(reasons: readonly { readonly code: string }[]): readonly string[] {
  return reasons.map((reason) => reason.code);
}
