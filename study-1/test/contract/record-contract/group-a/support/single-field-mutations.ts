// The AC-RUA-046 (group A) single-field mutations of design §12.5, shared by the exhaustive
// sweeps (single-field-mutation.contract.test.ts) and the fast-check property
// (test/fuzz/record-contract/group-a/single-field-mutation.fuzz.test.ts, Owner amendment A-11),
// so both always mutate the same sites with the same kind rules. The valid records are the
// canonical examples and the other branch of each conditional rule (canonical-examples.ts and
// branch-examples.ts).

import assert from 'node:assert/strict';

import type { JsonValue } from '../../../../../src/record-contract/primitives.ts';
import { allValidExamples } from './canonical-examples.ts';
import { isFreeText } from './json-scope.ts';
import { governedLeafSites, governedObjectSites } from './mutation-sites.ts';
import type { MutationSite } from './mutation-sites.ts';
import { catalogueValidator } from './validation-assertions.ts';

export type JsonKind = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

export const EXAMPLES = allValidExamples();
export const LEAF_SITES = governedLeafSites(EXAMPLES);
export const OBJECT_SITES = governedObjectSites(EXAMPLES);

/**
 * The JSON kind of a parsed value.
 *
 * @example
 * kindOf([1]); // 'array'
 */
export function kindOf(value: JsonValue): JsonKind {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value as 'boolean' | 'number' | 'string' | 'object';
}

/**
 * The JSON kinds a leaf may be replaced by. A meaningful null (the probe manifest's
 * `qualification`) is never replaced by a string, which could be a valid enum value elsewhere;
 * group A has no other leaf whose schema admits null.
 *
 * @example
 * otherKinds(null); // ['boolean', 'number', 'array', 'object']
 */
export function otherKinds(value: JsonValue): readonly JsonKind[] {
  const own = kindOf(value);
  const kinds: readonly JsonKind[] = ['null', 'boolean', 'number', 'string', 'array', 'object'];
  return kinds.filter((kind) => kind !== own && !(own === 'null' && kind === 'string'));
}

/**
 * Same-kind values that break the rule of every governed leaf of that kind: no governed group A
 * number admits a negative, fractional or unsafe value, no governed boolean admits the other
 * value, and no governed string except free text admits surrounding whitespace.
 *
 * @example
 * sameKindBreaks(site); // [-1, 0.5, 2 ** 53] for a number leaf
 */
export function sameKindBreaks(site: MutationSite): readonly JsonValue[] {
  const { value } = site;
  if (typeof value === 'number') {
    return [-1, 0.5, 2 ** 53];
  }
  if (typeof value === 'boolean') {
    return [!value];
  }
  return typeof value === 'string' && !isFreeText(site.path) ? [` ${value}`, `${value}\n`] : [];
}

/**
 * Fails when the catalogue accepts the mutated record. The failure message is built only on
 * failure: serializing every record would dominate.
 *
 * @example
 * assertRejectedMutation(withValueAt(record, ['amount_minor'], -1), () => 'payment/amount_minor = -1');
 */
export function assertRejectedMutation(mutated: JsonValue, describeMutation: () => string): void {
  if (catalogueValidator.validate(mutated).valid) {
    assert.fail(`${describeMutation()} was accepted: ${JSON.stringify(mutated)}`);
  }
}
