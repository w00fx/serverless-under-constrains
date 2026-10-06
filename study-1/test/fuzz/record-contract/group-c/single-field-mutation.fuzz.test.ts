// AC-RUA-046 property (design §12.5): a valid group-C record mutated in one field is rejected.
// The generator picks any governed leaf of any example and replaces it with a value of another
// JSON kind, or adds an unknown member to any governed object. Free-form values are skipped
// (any non-null JSON is valid there) and a meaningful null (BR-RUA-033) is never the
// replacement of a member that admits it. The A-05 hostile shapes are in the input space:
// replacement numbers include the non-finite ones `JSON.parse('1e400')` yields, and added
// members include the names every object inherits (A-07); a throw fails the property.
// The property lives under test/fuzz so `npm run test:fuzz` and `fuzz:campaign` reach it (Owner
// amendment A-11); its examples and helpers stay with the group's contract tests.
// FC_RUNS sets the budget and FC_SEED replays a failure (test/support/kernel/fuzz-parameters.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import { violationsOf } from '../../../support/record-contract/group-b-validation.ts';
import { leavesOf, objectPathsOf, pointerOf, withValueAt } from '../../../support/record-contract/json-paths.ts';
import type { JsonPath } from '../../../support/record-contract/json-paths.ts';
import { toJson } from '../../../support/record-contract/record-builders.ts';
import { GROUP_C_EXAMPLES } from '../../../contract/record-contract/group-c/examples/group-c-examples.ts';
import {
  INHERITED_MEMBER_NAMES,
  NON_FINITE_NUMBERS,
} from '../../../contract/record-contract/group-c/support/hostile-json.ts';
import { isFreeForm, isNullable } from '../../../contract/record-contract/group-c/support/json-scope.ts';

interface MutationSite {
  readonly label: string;
  readonly json: JsonValue;
  readonly path: JsonPath;
  readonly value: JsonValue;
}

const EXAMPLE_JSON = GROUP_C_EXAMPLES.map((example) => ({ label: example.label, json: toJson(example.record) }));

const LEAF_SITES: readonly MutationSite[] = EXAMPLE_JSON.flatMap(({ label, json }) =>
  leavesOf(json)
    .filter((leaf) => !isFreeForm(leaf.path))
    .map((leaf) => ({ label, json, path: leaf.path, value: leaf.value })),
);

const OBJECT_SITES: readonly MutationSite[] = EXAMPLE_JSON.flatMap(({ label, json }) =>
  objectPathsOf(json)
    .filter((path) => !isFreeForm(path))
    .map((path) => ({ label, json, path, value: null })),
);

// Unknown-member names never collide with catalogue names: no catalogued property starts `x_`.
const unknownObject = fc.dictionary(
  fc.stringMatching(/^[a-z]{1,6}$/).map((name) => `x_${name}`),
  fc.integer(),
  { maxKeys: 2 },
);
// JSON text never yields NaN, but `1e400` parses to Infinity (A-05).
const numbers = fc.oneof(
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom(...NON_FINITE_NUMBERS),
);
const arrays = fc.array(fc.integer(), { maxLength: 2 });

function replacementFor(site: MutationSite): fc.Arbitrary<JsonValue> {
  const nulls = isNullable(site.path) ? [] : [fc.constant<JsonValue>(null)];
  if (typeof site.value === 'string') {
    return fc.oneof(numbers, fc.boolean(), arrays, unknownObject, ...nulls);
  }
  if (typeof site.value === 'number') {
    return fc.oneof(fc.string(), fc.boolean(), arrays, unknownObject, ...nulls);
  }
  if (typeof site.value === 'boolean') {
    return fc.oneof(numbers, fc.string(), arrays, unknownObject, ...nulls);
  }
  // A meaningful null is replaced by a non-string kind: a string could be a valid enum value.
  return fc.oneof(numbers, fc.boolean(), arrays, unknownObject);
}

const leafMutation = fc
  .constantFrom(...LEAF_SITES)
  .chain((site) => replacementFor(site).map((replacement) => ({ site, replacement })));

const extraMember = fc.record({
  site: fc.constantFrom(...OBJECT_SITES),
  name: fc.oneof(
    fc.stringMatching(/^[a-z]{1,6}$/).map((name) => `x_${name}`),
    fc.constantFrom(...INHERITED_MEMBER_NAMES),
  ),
  member: fc.oneof(fc.constant<JsonValue>(null), fc.boolean(), fc.integer(), fc.string(), arrays),
});

describe('AC-RUA-046 single-field mutation property over group C', () => {
  it('generates over every governed leaf and object of the 23 record types', () => {
    assert.equal(new Set(EXAMPLE_JSON.map(({ json }) => json['record_type'])).size, 23);
    assert.equal(LEAF_SITES.length, 2260);
    assert.equal(OBJECT_SITES.length, 693);
  });

  it('a leaf replaced by a value of another JSON kind is rejected', () => {
    fc.assert(
      fc.property(leafMutation, ({ site, replacement }) => {
        const mutated = withValueAt(site.json, site.path, replacement);
        const where = `${site.label}${pointerOf(site.path)} = ${JSON.stringify(replacement)}`;
        assert.notDeepEqual(violationsOf(mutated), [], where);
      }),
      fuzzParameters(),
    );
  });

  it('an unknown member added to any governed object is rejected', () => {
    fc.assert(
      fc.property(extraMember, ({ site, name, member }) => {
        const mutated = withValueAt(site.json, [...site.path, name], member);
        assert.notDeepEqual(violationsOf(mutated), [], `${site.label}${pointerOf(site.path)}/${name}`);
      }),
      fuzzParameters(),
    );
  });
});
