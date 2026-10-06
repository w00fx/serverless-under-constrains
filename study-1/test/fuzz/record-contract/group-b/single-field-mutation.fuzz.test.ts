// AC-RUA-046 property (design §12.5): a valid group-B record mutated in one field is rejected.
// The generator picks any leaf of any example and replaces it with a value of another JSON
// kind, or adds an unknown member (a fresh or an inherited `Object.prototype` name) to any
// object of any example. Strings and booleans are never swapped for each other: the tri-state
// settlement fields legitimately admit both.
// The property lives under test/fuzz so `npm run test:fuzz` and `fuzz:campaign` reach it (Owner
// amendment A-11); its examples and helpers stay with the group's contract tests.
// FC_RUNS sets the budget and FC_SEED replays a failure (test/support/kernel/fuzz-parameters.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import { GROUP_B_EXAMPLES } from '../../../contract/record-contract/group-b/examples/group-b-examples.ts';
import { violationsOf } from '../../../support/record-contract/group-b-validation.ts';
import {
  INHERITED_MEMBER_NAMES,
  leavesOf,
  objectPathsOf,
  pointerOf,
  withValueAt,
} from '../../../support/record-contract/json-paths.ts';
import type { JsonPath } from '../../../support/record-contract/json-paths.ts';
import { toJson } from '../../../support/record-contract/record-builders.ts';

interface MutationSite {
  readonly label: string;
  readonly json: JsonValue;
  readonly path: JsonPath;
  readonly value: JsonValue;
}

const EXAMPLE_JSON = GROUP_B_EXAMPLES.map((example) => ({ label: example.label, json: toJson(example.record) }));

const LEAF_SITES: readonly MutationSite[] = EXAMPLE_JSON.flatMap(({ label, json }) =>
  leavesOf(json).map((leaf) => ({ label, json, path: leaf.path, value: leaf.value })),
);

const OBJECT_SITES: readonly MutationSite[] = EXAMPLE_JSON.flatMap(({ label, json }) =>
  objectPathsOf(json).map((path) => ({ label, json, path, value: null })),
);

// Unknown-member names never collide with catalogue names: no catalogued property starts `x_`.
const unknownObject = fc.dictionary(
  fc.stringMatching(/^[a-z]{1,6}$/).map((name) => `x_${name}`),
  fc.integer(),
  { maxKeys: 2 },
);
const numbers = fc.oneof(fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }));
const arrays = fc.array(fc.integer(), { maxLength: 2 });

function replacementFor(value: JsonValue): fc.Arbitrary<JsonValue> {
  if (typeof value === 'string') {
    return fc.oneof(numbers, fc.constant(null), arrays, unknownObject);
  }
  if (typeof value === 'number') {
    return fc.oneof(fc.string(), fc.boolean(), fc.constant(null), arrays, unknownObject);
  }
  return fc.oneof(numbers, fc.constant(null), arrays, unknownObject);
}

const leafMutation = fc
  .constantFrom(...LEAF_SITES)
  .chain((site) => replacementFor(site.value).map((replacement) => ({ site, replacement })));

// Extra-member names: fresh `x_` names, or a name `Object.prototype` defines (A-07: a validator
// that tracks members in a plain object once treated those as declared).
const extraMemberName = fc.oneof(
  fc.stringMatching(/^[a-z]{1,6}$/).map((name) => `x_${name}`),
  fc.constantFrom(...INHERITED_MEMBER_NAMES),
);

const extraMember = fc.record({
  site: fc.constantFrom(...OBJECT_SITES),
  name: extraMemberName,
  member: fc.oneof(fc.constant<JsonValue>(null), fc.boolean(), fc.integer(), fc.string(), arrays),
});

describe('AC-RUA-046 single-field mutation property over group B', () => {
  it('generates over every leaf and object of the 49 record types', () => {
    assert.equal(new Set(EXAMPLE_JSON.map(({ json }) => json['record_type'])).size, 49);
    assert.equal(LEAF_SITES.length, 1230);
    assert.equal(OBJECT_SITES.length, 111);
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

  it('an unknown member added to any object is rejected', () => {
    fc.assert(
      fc.property(extraMember, ({ site, name, member }) => {
        const mutated = withValueAt(site.json, [...site.path, name], member);
        assert.notDeepEqual(violationsOf(mutated), [], `${site.label}${pointerOf(site.path)}/${name}`);
      }),
      fuzzParameters(),
    );
  });
});
