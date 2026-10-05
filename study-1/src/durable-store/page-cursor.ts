// Opaque partition-query cursors (pure, a mutation target).
//
// A cursor carries the key of the last item a page returned (DynamoDB `LastEvaluatedKey`), as
// base64url of canonical JSON `{"pk":…,"sk":…}`. Callers treat it as opaque; the store
// decodes it strictly and refuses a cursor minted for another partition, because a query
// continued from a foreign key would silently skip or repeat items.

import { canonicalJson } from '../record-contract/canonical-json.ts';
import { isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import type { Result } from '../record-contract/primitives.ts';
import type { ItemKey } from './item-store-port.ts';

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
 * Decodes a cursor for the partition `pk`. Total over arbitrary strings.
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
  if (Object.keys(parsed.value).length !== 2 || typeof cursorPk !== 'string' || typeof cursorSk !== 'string') {
    return {
      ok: false,
      error: `cursor ${JSON.stringify(cursor)} holds ${canonicalJson(parsed.value)}; expected exactly string pk and sk`,
    };
  }
  if (cursorPk !== pk) {
    return {
      ok: false,
      error: `cursor belongs to partition ${JSON.stringify(cursorPk)}; expected partition ${JSON.stringify(pk)}`,
    };
  }
  return { ok: true, value: { pk: cursorPk, sk: cursorSk } };
}
