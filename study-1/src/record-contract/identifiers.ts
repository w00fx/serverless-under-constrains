// Identifier syntax of BR-RUA-033: every generated identity is a canonical lowercase UUIDv4.
// The JSON Schema `uuid` format accepts any version and uppercase, so the pattern is explicit
// (toolchain research §5).

import type { Result, StructuredReason, Uuid4 } from './primitives.ts';

export const UUID4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Tells whether a value is a canonical lowercase UUIDv4 string.
 *
 * @example
 * isUuid4('3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f'); // true
 * isUuid4('3F1C2A9E-8B4D-4C1E-9F00-1A2B3C4D5E6F'); // false (uppercase)
 */
export function isUuid4(value: unknown): value is Uuid4 {
  return typeof value === 'string' && UUID4_PATTERN.test(value);
}

/**
 * Parses an identifier, returning a structured reason that names the offending value.
 *
 * @example
 * const parsed = parseUuid4(input, 'trial_id');
 * if (!parsed.ok) reasons.push(parsed.error);
 */
export function parseUuid4(value: string, subject = 'uuid4'): Result<Uuid4, StructuredReason> {
  if (isUuid4(value)) {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: {
      code: 'INVALID_UUID4',
      subject,
      detail: `got ${JSON.stringify(value)}; expected a lowercase RFC 4122 version-4 UUID matching ${UUID4_PATTERN.source}`,
    },
  };
}
