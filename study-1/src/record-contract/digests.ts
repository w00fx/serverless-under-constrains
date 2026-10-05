// File digests are lowercase SHA-256 over the exact stored bytes (BR-RUA-033).

import { createHash } from 'node:crypto';

import type { Sha256Hex } from './primitives.ts';

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Digests exact bytes; never re-encodes or normalizes them first.
 *
 * @example
 * sha256Hex(new Uint8Array()); // 'e3b0c442...b855'
 */
export function sha256Hex(bytes: Uint8Array): Sha256Hex {
  return createHash('sha256').update(bytes).digest('hex') as Sha256Hex;
}

/**
 * Tells whether a value is a lowercase hexadecimal SHA-256 digest.
 *
 * @example
 * isSha256Hex('E3B0...'); // false (uppercase)
 */
export function isSha256Hex(value: unknown): value is Sha256Hex {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}
