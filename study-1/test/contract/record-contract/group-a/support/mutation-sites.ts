// The places of a valid group A record that the catalogue-wide checks mutate: every governed
// leaf and every governed object at any depth (support/json-scope.ts lists the open members),
// and every number leaf. The §12.5 sweeps and property (single-field-mutations.ts) and the
// hostile-input cases (hostile-input.contract.test.ts) draw from these lists, so both always
// cover the same sites.

import type { JsonObject, JsonValue } from '../../../../../src/record-contract/primitives.ts';
import { leavesOf, objectPathsOf } from '../../../../support/record-contract/json-paths.ts';
import type { JsonPath } from '../../../../support/record-contract/json-paths.ts';
import type { NamedExample } from './canonical-examples.ts';
import { isKindFree, isOpenObject } from './json-scope.ts';

export interface MutationSite {
  /** The example's name, for failure messages. */
  readonly label: string;
  readonly record: JsonObject;
  readonly path: JsonPath;
  /** The value found at `path`; null for an object site. */
  readonly value: JsonValue;
}

/**
 * Every leaf whose JSON kind the schema fixes: replacing it with another kind must be rejected.
 *
 * @example
 * governedLeafSites(allValidExamples()).map((site) => pointerOf(site.path)); // ['/schema_version', ...]
 */
export function governedLeafSites(examples: readonly NamedExample[]): readonly MutationSite[] {
  return examples.flatMap(({ name, record }) =>
    leavesOf(record)
      .filter((leaf) => !isKindFree(leaf.path))
      .map((leaf) => ({ label: name, record, path: leaf.path, value: leaf.value })),
  );
}

/**
 * Every object, the root included, that the schema closes: an undeclared member must be rejected.
 *
 * @example
 * governedObjectSites(allValidExamples()).map((site) => pointerOf(site.path)); // ['', '/timing', ...]
 */
export function governedObjectSites(examples: readonly NamedExample[]): readonly MutationSite[] {
  return examples.flatMap(({ name, record }) =>
    objectPathsOf(record)
      .filter((path) => !isOpenObject(path))
      .map((path) => ({ label: name, record, path, value: null })),
  );
}

/**
 * Every number leaf, governed or free: a non-finite number must be rejected wherever it lands.
 *
 * @example
 * numberLeafSites(allValidExamples()).some((site) => pointerOf(site.path) === '/sequence'); // true
 */
export function numberLeafSites(examples: readonly NamedExample[]): readonly MutationSite[] {
  return examples.flatMap(({ name, record }) =>
    leavesOf(record)
      .filter((leaf) => typeof leaf.value === 'number')
      .map((leaf) => ({ label: name, record, path: leaf.path, value: leaf.value })),
  );
}
