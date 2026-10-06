// RFC 6901 JSON Pointer resolution over parsed evidence (BR-RUA-035 `json_pointer`). It reads only
// own members, so `/constructor` or `/__proto__` resolve only when the document really has such a
// member (A-05), and it walks one token at a time, so any nesting depth is fine.

import type { JsonValue } from '../record-contract/primitives.ts';

/** A resolved value, or the fact that the pointer names nothing in the document. */
export type PointerResolution = { readonly found: true; readonly value: JsonValue } | { readonly found: false };

const ARRAY_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;
const ESCAPE_PATTERN = /~(?![01])/;

/**
 * Resolves `pointer` inside `document`. The empty pointer is the whole document; a pointer that
 * is malformed (no leading `/`, or a `~` not followed by `0` or `1`) resolves to nothing.
 *
 * @example
 * resolveJsonPointer({ a: [{ b: 1 }] }, '/a/0/b'); // { found: true, value: 1 }
 * resolveJsonPointer({ a: 1 }, '/constructor'); // { found: false }
 */
export function resolveJsonPointer(document: JsonValue, pointer: string): PointerResolution {
  if (pointer === '') {
    return { found: true, value: document };
  }
  if (!pointer.startsWith('/') || ESCAPE_PATTERN.test(pointer)) {
    return { found: false };
  }
  let current: JsonValue = document;
  for (const token of pointer.slice(1).split('/')) {
    const next = childOf(current, token.replaceAll('~1', '/').replaceAll('~0', '~'));
    if (!next.found) {
      return next;
    }
    current = next.value;
  }
  return { found: true, value: current };
}

function childOf(container: JsonValue, token: string): PointerResolution {
  if (Array.isArray(container)) {
    const items: readonly JsonValue[] = container;
    const index = ARRAY_INDEX_PATTERN.test(token) ? Number(token) : -1;
    return index >= 0 && index < items.length ? { found: true, value: items[index] as JsonValue } : { found: false };
  }
  if (typeof container !== 'object' || container === null || !Object.hasOwn(container, token)) {
    return { found: false };
  }
  return { found: true, value: (container as Readonly<Record<string, JsonValue>>)[token] as JsonValue };
}
