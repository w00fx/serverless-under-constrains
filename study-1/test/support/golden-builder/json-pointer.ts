// RFC 6901 JSON Pointer edits over parsed JSON, used by the scenario operations to change one
// member of one record. Edits copy the containers along the path and share everything else, and
// every walk is a loop over the pointer's tokens, so a pointer of any depth is answered with a
// result instead of a stack overflow (Owner amendment A-05). Members are read only when they are
// own properties, so `__proto__` or `constructor` name ordinary members, never inherited ones.

import { boundedJsonText } from '../../../src/record-contract/json-value.ts';
import type { JsonValue, Result } from '../../../src/record-contract/primitives.ts';
import { defineMember } from './digest-links.ts';

const ARRAY_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;

/**
 * Splits a pointer into unescaped tokens; `''` is the whole document.
 *
 * @example
 * parsePointer('/a~1b/0'); // { ok: true, value: ['a/b', '0'] }
 */
export function parsePointer(pointer: string): Result<readonly string[], string> {
  if (pointer === '') {
    return { ok: true, value: [] };
  }
  if (!pointer.startsWith('/')) {
    return { ok: false, error: `pointer ${boundedJsonText(pointer)}; expected '' or a string starting with '/'` };
  }
  const tokens = pointer.slice(1).split('/');
  if (tokens.some((token) => /~(?![01])/.test(token))) {
    return { ok: false, error: `pointer ${boundedJsonText(pointer)} has a bare '~'; expected '~0' or '~1' escapes` };
  }
  return { ok: true, value: tokens.map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~')) };
}

/**
 * A copy of `document` with the member at `pointer` set to `value`. The parent must exist; an
 * array index may be the array length or `-` to append.
 *
 * @example
 * setAtPointer({ a: { b: 1 } }, '/a/b', 2); // { ok: true, value: { a: { b: 2 } } }
 */
export function setAtPointer(document: JsonValue, pointer: string, value: JsonValue): Result<JsonValue, string> {
  return editAtPointer(document, pointer, (parent, token) => replaceMember(parent, token, value, pointer));
}

/**
 * A copy of `document` without the member at `pointer`, which must exist.
 *
 * @example
 * removeAtPointer({ a: 1, b: 2 }, '/a'); // { ok: true, value: { b: 2 } }
 */
export function removeAtPointer(document: JsonValue, pointer: string): Result<JsonValue, string> {
  return editAtPointer(document, pointer, (parent, token) => deleteMember(parent, token, pointer));
}

type ParentEdit = (parent: JsonValue, token: string) => Result<JsonValue, string>;

function editAtPointer(document: JsonValue, pointer: string, edit: ParentEdit): Result<JsonValue, string> {
  const tokens = parsePointer(pointer);
  if (!tokens.ok) {
    return tokens;
  }
  const last = tokens.value.at(-1);
  if (last === undefined) {
    return { ok: false, error: `pointer '' names the whole record; expected a member pointer such as '/field'` };
  }
  const parents: { readonly container: JsonValue; readonly token: string }[] = [];
  let current = document;
  for (const token of tokens.value.slice(0, -1)) {
    const child = memberOf(current, token);
    if (child === undefined) {
      return {
        ok: false,
        error: `pointer ${boundedJsonText(pointer)} has no member ${boundedJsonText(token)}; expected an existing parent`,
      };
    }
    parents.push({ container: current, token });
    current = child;
  }
  let edited = edit(current, last);
  for (const { container, token } of parents.reverse()) {
    if (!edited.ok) {
      return edited;
    }
    edited = replaceMember(container, token, edited.value, pointer);
  }
  return edited;
}

/**
 * The member a token names inside a container, or undefined: own properties only, and array
 * indexes only in canonical decimal form.
 *
 * @example
 * memberOf({ a: 1 }, 'a'); // 1
 * memberOf({}, '__proto__'); // undefined
 */
export function memberOf(container: JsonValue, token: string): JsonValue | undefined {
  if (Array.isArray(container)) {
    return ARRAY_INDEX_PATTERN.test(token) ? (container as readonly JsonValue[])[Number(token)] : undefined;
  }
  if (container === null || typeof container !== 'object' || !Object.hasOwn(container, token)) {
    return undefined;
  }
  return (container as Readonly<Record<string, JsonValue>>)[token];
}

function replaceMember(parent: JsonValue, token: string, value: JsonValue, pointer: string): Result<JsonValue, string> {
  if (Array.isArray(parent)) {
    const items = [...(parent as readonly JsonValue[])];
    const index = token === '-' ? items.length : arrayIndex(token, items.length);
    if (index === undefined) {
      return {
        ok: false,
        error: `pointer ${boundedJsonText(pointer)} index ${boundedJsonText(token)}; expected 0..${String(items.length)} or '-'`,
      };
    }
    items[index] = value;
    return { ok: true, value: items };
  }
  if (parent === null || typeof parent !== 'object') {
    return {
      ok: false,
      error: `pointer ${boundedJsonText(pointer)} crosses a ${parent === null ? 'null' : typeof parent}; expected objects and arrays`,
    };
  }
  const copy = copyObject(parent as Readonly<Record<string, JsonValue>>);
  defineMember(copy, token, value);
  return { ok: true, value: copy };
}

function deleteMember(parent: JsonValue, token: string, pointer: string): Result<JsonValue, string> {
  if (memberOf(parent, token) === undefined) {
    return { ok: false, error: `pointer ${boundedJsonText(pointer)} names no existing member; expected one to remove` };
  }
  if (Array.isArray(parent)) {
    return { ok: true, value: (parent as readonly JsonValue[]).filter((_item, index) => index !== Number(token)) };
  }
  const copy = copyObject(parent as Readonly<Record<string, JsonValue>>);
  Reflect.deleteProperty(copy, token);
  return { ok: true, value: copy };
}

function arrayIndex(token: string, length: number): number | undefined {
  const index = ARRAY_INDEX_PATTERN.test(token) ? Number(token) : Number.NaN;
  return index <= length ? index : undefined;
}

function copyObject(source: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const copy: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(source)) {
    defineMember(copy, key, value);
  }
  return copy;
}
