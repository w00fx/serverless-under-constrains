// Opaque partition-query cursors (pure, a mutation target).
//
// A cursor carries the key of the last item a page returned (DynamoDB `LastEvaluatedKey`), as
// base64url of canonical JSON `{"pk":…,"sk":…}`. Callers treat it as opaque; the store
// decodes it strictly and refuses a cursor minted for another partition, because a query
// continued from a foreign key would silently skip or repeat items. The cursor's key must be a
// valid DynamoDB key, as it becomes `ExclusiveStartKey`: the service refuses an empty sort key,
// and the emulator must refuse it the same way (WP-04 review round 1).
// Error messages never re-serialize the decoded payload: a hostile cursor may nest deeper than
// any recursive serializer can follow, so they name only its member names and value types.

import { canonicalJson } from '../record-contract/canonical-json.ts';
import { isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import type { JsonValue, Result } from '../record-contract/primitives.ts';
import type { ItemKey } from './item-store-port.ts';
import { keyViolations } from './write-action-validation.ts';

/**
 * Encodes the key of the last returned item as a cursor.
 *
 * @example
 * encodePageCursor({ pk: 'run#trial', sk: 'tx#1' }); // 'eyJwayI6InJ1biN0cmlhbCIsInNrIjoidHgjMSJ9'
 */
export function encodePageCursor(key: ItemKey): string {
  return Buffer.from(canonicalJson({ pk: key.pk, sk: key.sk }), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor for the partition `pk`. Total over arbitrary strings: it never throws.
 *
 * @example
 * const start = decodePageCursor(cursor, pk);
 * if (!start.ok) return { ok: false, error: { code: 'InvalidCursor' } };
 */
export function decodePageCursor(cursor: string, pk: string): Result<ItemKey, string> {
  const bytes = Buffer.from(cursor, 'base64url');
  // Node's base64url decoder accepts the base64 alphabet and padding and skips other
  // characters, so only a cursor that re-encodes to itself is one this module produced.
  if (bytes.toString('base64url') !== cursor) {
    return { ok: false, error: `cursor ${JSON.stringify(cursor)} is not canonical base64url; expected a page cursor` };
  }
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    return { ok: false, error: `cursor ${JSON.stringify(cursor)} does not hold a JSON object; expected {"pk","sk"}` };
  }
  const { pk: cursorPk, sk: cursorSk } = parsed.value;
  const names = Object.keys(parsed.value);
  if (names.length !== 2 || typeof cursorPk !== 'string' || typeof cursorSk !== 'string') {
    return {
      ok: false,
      error: `cursor ${JSON.stringify(cursor)} holds members ${JSON.stringify(names)} with pk ${jsonTypeOf(cursorPk)} and sk ${jsonTypeOf(cursorSk)}; expected exactly string pk and sk`,
    };
  }
  if (cursorPk !== pk) {
    return {
      ok: false,
      error: `cursor belongs to partition ${JSON.stringify(cursorPk)}; expected partition ${JSON.stringify(pk)}`,
    };
  }
  const [keyViolation] = keyViolations({ pk: cursorPk, sk: cursorSk }, 'cursor');
  return keyViolation === undefined
    ? { ok: true, value: { pk: cursorPk, sk: cursorSk } }
    : { ok: false, error: keyViolation };
}

// Names a parsed JSON value's type without serializing it.
function jsonTypeOf(value: JsonValue | undefined): string {
  if (value === undefined) {
    return 'absent';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a ${typeof value === 'object' ? 'map' : typeof value}`;
}
