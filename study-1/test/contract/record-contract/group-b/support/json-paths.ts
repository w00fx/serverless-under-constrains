// Path utilities over parsed JSON for single-field mutations: list every leaf, walk a path or a
// `*` pattern, and copy a document with one value replaced, removed or added. Every group-B test
// walks JSON through these, so path semantics live in one place.

import { isJsonArray, isJsonObject } from '../../../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../../../src/record-contract/primitives.ts';

export type JsonPath = readonly (string | number)[];

export interface JsonLeaf {
  readonly path: JsonPath;
  readonly value: JsonValue;
}

/**
 * Lists every non-container value with its path, depth first.
 *
 * @example
 * leavesOf({ a: [1, { b: true }] }); // [{ path: ['a', 0], value: 1 }, { path: ['a', 1, 'b'], value: true }]
 */
export function leavesOf(value: JsonValue, path: JsonPath = []): readonly JsonLeaf[] {
  if (isJsonArray(value)) {
    return value.flatMap((child, index) => leavesOf(child, [...path, index]));
  }
  if (isJsonObject(value)) {
    return Object.entries(value).flatMap(([key, child]) => leavesOf(child, [...path, key]));
  }
  return [{ path, value }];
}

/**
 * Lists the path of every object (the root included), so closure can be tested at each level.
 *
 * @example
 * objectPathsOf({ a: { b: 1 }, c: [{}] }); // [[], ['a'], ['c', 0]]
 */
export function objectPathsOf(value: JsonValue, path: JsonPath = []): readonly JsonPath[] {
  if (isJsonArray(value)) {
    return value.flatMap((child, index) => objectPathsOf(child, [...path, index]));
  }
  if (!isJsonObject(value)) {
    return [];
  }
  return [path, ...Object.entries(value).flatMap(([key, child]) => objectPathsOf(child, [...path, key]))];
}

/**
 * Copies `root` with the value at `path` replaced (`undefined` removes an object member).
 *
 * @example
 * withValueAt({ a: { b: 1 } }, ['a', 'b'], 2); // { a: { b: 2 } }
 */
export function withValueAt(root: JsonValue, path: JsonPath, next: JsonValue | undefined): JsonValue {
  const [head, ...rest] = path;
  if (head === undefined) {
    if (next === undefined) {
      throw new Error('cannot remove the document root; expected a non-empty path');
    }
    return next;
  }
  if (isJsonArray(root) && typeof head === 'number') {
    return root.map((child, index) => (index === head ? withValueAt(child, rest, next) : child));
  }
  if (isJsonObject(root) && typeof head === 'string') {
    return replaceMember(root, head, rest.length === 0 ? next : withValueAt(member(root, head), rest, next));
  }
  throw new Error(`path segment ${JSON.stringify(head)} does not address ${JSON.stringify(root)}; expected a member`);
}

/**
 * Copies a document object with one top-level member set, or removed when `next` is undefined.
 *
 * @example
 * withMember({ a: 1 }, 'b', 2); // { a: 1, b: 2 }
 */
export function withMember(root: JsonObject, key: string, next: JsonValue | undefined): JsonObject {
  return replaceMember(root, key, next);
}

/**
 * Copies a document object without the named top-level members.
 *
 * @example
 * withoutMembers({ a: 1, b: 2, c: 3 }, ['a', 'c']); // { b: 2 }
 */
export function withoutMembers(root: JsonObject, keys: readonly string[]): JsonObject {
  return Object.fromEntries(Object.entries(root).filter(([key]) => !keys.includes(key)));
}

/**
 * A string leaf as itself, any other JSON value as its serialization (for string mutations).
 *
 * @example
 * textOf('a'); // 'a'
 * textOf(12); // '12'
 */
export function textOf(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The value one segment below `node`: an array element for a number (or a digit string, as a
 * JSON Pointer spells it), an own object member for a string; undefined when nothing is there.
 * Only own members are read, so `constructor` or `toString` never resolve to inherited values.
 *
 * @example
 * childAt([10, 20], 1); // 20
 * childAt({ a: 1 }, 'toString'); // undefined
 */
export function childAt(node: JsonValue | undefined, segment: string | number): JsonValue | undefined {
  if (isJsonArray(node)) {
    const index = typeof segment === 'number' ? segment : Number(segment);
    return Number.isInteger(index) ? node[index] : undefined;
  }
  if (isJsonObject(node) && typeof segment === 'string' && Object.hasOwn(node, segment)) {
    return node[segment];
  }
  return undefined;
}

/**
 * The value at `path`, or undefined when the path leads nowhere.
 *
 * @example
 * valueAt({ a: [{ b: 1 }] }, ['a', 0, 'b']); // 1
 */
export function valueAt(root: JsonValue, path: readonly (string | number)[]): JsonValue | undefined {
  return path.reduce<JsonValue | undefined>((node, segment) => childAt(node, segment), root);
}

/**
 * The object at `path`; throws when the path addresses anything else.
 *
 * @example
 * objectAt({ a: [{ b: 1 }] }, ['a', 0]); // { b: 1 }
 */
export function objectAt(root: JsonValue, path: JsonPath): JsonObject {
  const node = valueAt(root, path);
  if (!isJsonObject(node)) {
    throw new Error(`path ${pointerOf(path)} addresses ${JSON.stringify(node)}; expected an object`);
  }
  return node;
}

/**
 * A concrete path as its pattern, every array index written `*` (the `nested_optional` form).
 *
 * @example
 * patternOf(['executions', 0, 'ended_at']); // '/executions/*\/ended_at'
 */
export function patternOf(path: JsonPath): string {
  return path.map((segment) => (typeof segment === 'number' ? '/*' : `/${segment}`)).join('');
}

/**
 * Every concrete path in `root` that a pattern names (the inverse of `patternOf`).
 *
 * @example
 * pathsMatching({ a: [{ b: 1 }, { b: 2 }] }, '/a/*\/b'); // [['a', 0, 'b'], ['a', 1, 'b']]
 */
export function pathsMatching(root: JsonValue, pattern: string): readonly JsonPath[] {
  const expand = (node: JsonValue, segments: readonly string[], path: JsonPath): readonly JsonPath[] => {
    const [head, ...rest] = segments;
    if (head === undefined) {
      return [path];
    }
    if (head === '*') {
      return isJsonArray(node) ? node.flatMap((child, index) => expand(child, rest, [...path, index])) : [];
    }
    const child = childAt(node, head);
    return child === undefined || isJsonArray(node) ? [] : expand(child, rest, [...path, head]);
  };
  return expand(root, pattern.split('/').slice(1), []);
}

/**
 * Renders a path as a JSON Pointer for assertion labels and violation matching.
 *
 * @example
 * pointerOf(['messages', 0, 'body']); // '/messages/0/body'
 */
export function pointerOf(path: JsonPath): string {
  return path.map((segment) => `/${String(segment)}`).join('');
}

function member(root: JsonObject, key: string): JsonValue {
  const value = root[key];
  if (value === undefined) {
    throw new Error(`member ${JSON.stringify(key)} is absent from ${JSON.stringify(root)}; expected it present`);
  }
  return value;
}

function replaceMember(root: JsonObject, key: string, next: JsonValue | undefined): JsonObject {
  const kept = Object.entries(root).filter(([name]) => name !== key);
  return Object.fromEntries(next === undefined ? kept : [...kept, [key, next]]);
}

/**
 * Every own property name of `Object.prototype` (`__proto__`, `constructor`, `toString`, ...).
 * A validator that tracks members in a plain object sees these as present on every object, so
 * each closed object must be proven to reject them as unknown members (Owner amendment A-07).
 *
 * @example
 * INHERITED_MEMBER_NAMES.includes('hasOwnProperty'); // true
 */
export const INHERITED_MEMBER_NAMES: readonly string[] = Object.getOwnPropertyNames(Object.prototype).toSorted();
