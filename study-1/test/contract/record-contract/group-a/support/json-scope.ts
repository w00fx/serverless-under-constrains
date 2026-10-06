// Which parts of a group A record the generic AC-RUA-046 mutation checks may mutate. A few
// members are deliberately open, so a schema is right to accept the mutation there:
// - kind-free values, where another JSON kind is still valid: the preflight `expected` and
//   `observed` values (any record JSON without null), the runtime property values of the
//   transport-scope snapshot and each side of a declared variant difference (string, safe
//   integer or boolean);
// - open maps, whose member names are data (any snake_case name is valid): the resource
//   counts, the tool versions, the runtime properties and every object inside a preflight value;
// - free text, where a string padded with whitespace is still valid: reason subjects and
//   details, a check subject, a difference basis, a physical id, output and tag values, the
//   canonical JSON text of foreign configuration, and every package-relative path (the kernel
//   path format admits spaces).
// This is the single list of exemptions; every other leaf and object is governed.

import type { JsonPath } from '../../group-b/support/json-paths.ts';

/** Top-level members whose whole value is free record JSON. */
const FREE_VALUE_MEMBERS: readonly string[] = ['expected', 'observed'];

/** Members whose own value may be any scalar kind. */
const SCALAR_OF_ANY_KIND_MEMBERS: readonly string[] = ['conventional', 'durable'];

/** Members that are maps keyed by data rather than by declared property names. */
const OPEN_MAP_MEMBERS: readonly string[] = ['resource_counts', 'tool_versions', 'runtime_properties'];

/** String members that hold free text or a package-relative path. */
const FREE_TEXT_MEMBERS: readonly string[] = [
  'subject',
  'detail',
  'basis',
  'physical_id',
  'canonical_json',
  'path',
  'assembly_path',
  'template_path',
  'relative_path',
  'lockfile_path',
  'artifact_path',
];

/** Lists whose items are package-relative paths, and lists whose items carry a free `value`. */
const PATH_LIST_MEMBERS: readonly string[] = ['entry_points', 'source_roots'];
const FREE_VALUE_LIST_MEMBERS: readonly string[] = ['outputs', 'ownership_tags'];

/**
 * True when another JSON kind at `path` is still valid, so a kind replacement there proves
 * nothing.
 *
 * @example
 * isKindFree(['observed', 'approved_amount_minor']); // true
 * isKindFree(['runtime_properties', 'node_runtime']); // true
 * isKindFree(['timing', 'provider_client_deadline_ms']); // false
 */
export function isKindFree(path: JsonPath): boolean {
  const last = path.at(-1);
  // A string segment is a map member; the policy's `runtime_properties` is an array of names.
  const inRuntimeMap = path.at(-2) === 'runtime_properties' && typeof last === 'string';
  return (
    FREE_VALUE_MEMBERS.includes(String(path[0])) ||
    inRuntimeMap ||
    (path[0] === 'declared_variant_differences' && SCALAR_OF_ANY_KIND_MEMBERS.includes(String(last)))
  );
}

/**
 * True when the object at `path` accepts members it does not declare, so adding one proves
 * nothing.
 *
 * @example
 * isOpenObject(['estimates', 'resource_counts']); // true
 * isOpenObject(['expected', 'limits', 0]); // true
 * isOpenObject(['timing']); // false
 */
export function isOpenObject(path: JsonPath): boolean {
  return FREE_VALUE_MEMBERS.includes(String(path[0])) || OPEN_MAP_MEMBERS.includes(String(path.at(-1)));
}

/**
 * True when the string at `path` is free text or a package-relative path, so padding it with
 * whitespace keeps it valid and proves nothing.
 *
 * @example
 * isFreeText(['reasons', 0, 'detail']); // true
 * isFreeText(['entry_points', 1]); // true
 * isFreeText(['payment_id']); // false
 */
export function isFreeText(path: JsonPath): boolean {
  const last = String(path.at(-1));
  return (
    FREE_TEXT_MEMBERS.includes(last) ||
    PATH_LIST_MEMBERS.includes(String(path.at(-2))) ||
    (last === 'value' && FREE_VALUE_LIST_MEMBERS.includes(String(path.at(-3))))
  );
}
