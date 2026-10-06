// AC-RUA-046 (group A) property of design §12.5, "record validators (each group): a valid
// generated record mutated in one field is rejected", with generated values. The exhaustive
// sweeps over the same sites, with one fixed value per JSON kind, are in
// test/contract/record-contract/group-a/single-field-mutation.contract.test.ts; both draw their
// sites and kind rules from that folder's support/single-field-mutations.ts. The property lives
// here so `npm run test:fuzz` and `fuzz:campaign` reach it (Owner amendment A-11). FC_RUNS sets
// the property budget and FC_SEED replays a failure (test/support/kernel/fuzz-parameters.ts).

import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { MutationSite } from '../../../contract/record-contract/group-a/support/mutation-sites.ts';
import {
  assertRejectedMutation,
  LEAF_SITES,
  OBJECT_SITES,
  otherKinds,
  sameKindBreaks,
} from '../../../contract/record-contract/group-a/support/single-field-mutations.ts';
import type { JsonKind } from '../../../contract/record-contract/group-a/support/single-field-mutations.ts';
import { pointerOf, withValueAt } from '../../../support/record-contract/json-paths.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';

const UNKNOWN_OBJECT = fc.dictionary(
  fc.stringMatching(/^[a-z]{1,6}$/).map((name) => `x_${name}`),
  fc.integer(),
  { maxKeys: 2 },
);
const ARBITRARY_BY_KIND: Readonly<Record<JsonKind, fc.Arbitrary<JsonValue>>> = {
  null: fc.constant(null),
  boolean: fc.boolean(),
  number: fc.oneof(fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true })),
  string: fc.string({ maxLength: 12 }),
  array: fc.array(fc.integer(), { maxLength: 2 }),
  object: UNKNOWN_OBJECT,
};

const WHITESPACE = fc.constantFrom(' ', '\t', '\n', '\r');
const BROKEN_NUMBER: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.integer({ min: Number.MIN_SAFE_INTEGER, max: -1 }),
  fc.integer().map((whole) => whole + 0.5),
  fc.double({ min: 2 ** 53, max: 1e300, noNaN: true }),
);

function sameKindArbitrary(site: MutationSite): fc.Arbitrary<JsonValue> {
  const { value } = site;
  if (typeof value === 'number') {
    return BROKEN_NUMBER;
  }
  if (typeof value === 'string') {
    return fc
      .tuple(WHITESPACE, fc.boolean())
      .map(([space, before]) => (before ? `${space}${value}` : `${value}${space}`));
  }
  return fc.constant(!value);
}

// No group A record declares a member that starts with `x_`, so the name is always unknown.
const UNKNOWN_MEMBER_NAME = fc.stringMatching(/^[a-z]{1,6}$/).map((name) => `x_${name}`);

describe('record validators (group A)', () => {
  it('a valid generated record mutated in one field is rejected', () => {
    const leafMutation = fc
      .constantFrom(...LEAF_SITES)
      .chain((site) =>
        fc
          .constantFrom(...otherKinds(site.value))
          .chain((kind) => ARBITRARY_BY_KIND[kind].map((replacement) => ({ site, replacement }))),
      );
    fc.assert(
      fc.property(leafMutation, ({ site, replacement }) => {
        assertRejectedMutation(
          withValueAt(site.record, site.path, replacement),
          () => `${site.label}${pointerOf(site.path)} = ${JSON.stringify(replacement)}`,
        );
      }),
      fuzzParameters(),
    );

    const sameKindSites = LEAF_SITES.filter((site) => sameKindBreaks(site).length > 0);
    const sameKindMutation = fc
      .constantFrom(...sameKindSites)
      .chain((site) => sameKindArbitrary(site).map((replacement) => ({ site, replacement })));
    fc.assert(
      fc.property(sameKindMutation, ({ site, replacement }) => {
        assertRejectedMutation(
          withValueAt(site.record, site.path, replacement),
          () => `${site.label}${pointerOf(site.path)} = ${JSON.stringify(replacement)}`,
        );
      }),
      fuzzParameters(),
    );

    const extraMember = fc.record({
      site: fc.constantFrom(...OBJECT_SITES),
      name: UNKNOWN_MEMBER_NAME,
      member: fc.jsonValue(),
    });
    fc.assert(
      fc.property(extraMember, ({ site, name, member }) => {
        assertRejectedMutation(
          withValueAt(site.record, [...site.path, name], member as JsonValue),
          () => `${site.label}${pointerOf(site.path)}/${name}`,
        );
      }),
      fuzzParameters(),
    );
  });
});
