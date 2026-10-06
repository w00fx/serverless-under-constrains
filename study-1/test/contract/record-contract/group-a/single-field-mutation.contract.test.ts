// AC-RUA-046 (group A) property of design §12.5, "record validators (each group): a valid
// generated record mutated in one field is rejected". The valid records are the canonical
// examples and the other branch of each conditional rule (support/canonical-examples.ts and
// support/branch-examples.ts). A
// mutation site is any governed leaf, at any depth, replaced by a value of another JSON kind;
// any governed object, given an unknown member; or any top-level required member, removed.
// The open members the schemas deliberately accept are listed once, in support/json-scope.ts.
// Each mutation kind runs twice: an exhaustive sweep with one fixed value per JSON kind over
// every site, then a fast-check property with generated values. FC_RUNS sets the property
// budget and FC_SEED replays a failure (test/support/kernel/fuzz-parameters.ts).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import { DEFAULT_SCHEMA_ROOT, listSchemaFiles } from '../../../../src/record-contract/schema-registry.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import { pointerOf, withValueAt } from '../group-b/support/json-paths.ts';
import { allValidExamples } from './support/canonical-examples.ts';
import { governedLeafSites, governedObjectSites } from './support/mutation-sites.ts';
import type { MutationSite } from './support/mutation-sites.ts';
import { catalogueValidator, withoutField } from './support/validation-assertions.ts';

type JsonKind = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

const EXAMPLES = allValidExamples();

function readRequiredMembers(): ReadonlyMap<string, readonly string[]> {
  const required = new Map<string, readonly string[]>();
  for (const file of listSchemaFiles().filter((entry) => entry.relative_path.startsWith('group-a/'))) {
    const schema = JSON.parse(readFileSync(join(DEFAULT_SCHEMA_ROOT, file.relative_path), 'utf8')) as {
      readonly required: readonly string[];
    };
    required.set(file.record_type, schema.required);
  }
  return required;
}

const REQUIRED_MEMBERS = readRequiredMembers();

function requiredOf(record: JsonObject, label: string): readonly string[] {
  const recordType = record['record_type'];
  const required = typeof recordType === 'string' ? REQUIRED_MEMBERS.get(recordType) : undefined;
  if (required === undefined) {
    throw new Error(
      `example ${JSON.stringify(label)} has no group A schema; expected one of ${[...REQUIRED_MEMBERS.keys()].join(', ')}`,
    );
  }
  return required;
}

const LEAF_SITES = governedLeafSites(EXAMPLES);
const OBJECT_SITES = governedObjectSites(EXAMPLES);

const REMOVAL_SITES: readonly MutationSite[] = EXAMPLES.flatMap(({ name, record }) =>
  requiredOf(record, name).map((member) => ({ label: name, record, path: [member], value: null })),
);

function kindOf(value: JsonValue): JsonKind {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value as 'boolean' | 'number' | 'string' | 'object';
}

// One representative per JSON kind for the exhaustive sweep. A meaningful null (the probe
// manifest's `qualification`) is never replaced by a string, which could be a valid enum value
// elsewhere; group A has no other leaf whose schema admits null.
const KIND_REPRESENTATIVES: Readonly<Record<JsonKind, JsonValue>> = {
  null: null,
  boolean: true,
  number: 7,
  string: 'x',
  array: [1],
  object: { x_unknown: 1 },
};

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

function otherKinds(value: JsonValue): readonly JsonKind[] {
  const own = kindOf(value);
  const kinds: readonly JsonKind[] = ['null', 'boolean', 'number', 'string', 'array', 'object'];
  return kinds.filter((kind) => kind !== own && !(own === 'null' && kind === 'string'));
}

// No group A record declares a member that starts with `x_`, so the name is always unknown.
const UNKNOWN_MEMBER_NAME = fc.stringMatching(/^[a-z]{1,6}$/).map((name) => `x_${name}`);

// The failure message is built only on failure: serializing every record would dominate.
function assertRejectedMutation(mutated: JsonValue, describeMutation: () => string): void {
  if (catalogueValidator.validate(mutated).valid) {
    assert.fail(`${describeMutation()} was accepted: ${JSON.stringify(mutated)}`);
  }
}

describe('record validators (group A)', () => {
  it('generates over every governed leaf and object of the 18 record types', () => {
    assert.equal(new Set(EXAMPLES.map(({ record }) => record['record_type'])).size, 18);
    assert.equal(EXAMPLES.length, 32);
    assert.equal(LEAF_SITES.length, 700);
    assert.equal(OBJECT_SITES.length, 137);
    assert.equal(REMOVAL_SITES.length, 318);
    // Nested sites are generated, not only top-level members.
    assert.ok(LEAF_SITES.some((site) => pointerOf(site.path) === '/timing/provider_client_deadline_ms'));
    assert.ok(LEAF_SITES.some((site) => pointerOf(site.path) === '/files/1/sha256'));
    assert.ok(OBJECT_SITES.some((site) => pointerOf(site.path) === '/configuration_projections/0/resources/0'));
    // The branch examples are swept too: the validation stack's variant tag and a validation identity.
    const labelled = (label: string, pointer: string): boolean =>
      LEAF_SITES.some((site) => site.label === label && pointerOf(site.path) === pointer);
    assert.ok(labelled('resource_manifest (variant validation stack)', '/ownership_tags/5/value'));
    assert.ok(labelled('trial_registration (variant validation)', '/variant_validation_id'));
    for (const valid of EXAMPLES) {
      assert.equal(catalogueValidator.validate(valid.record).valid, true, valid.name);
    }
    assert.throws(() => requiredOf({ record_type: 'refund_effect' }, 'stray'), /no group A schema/);
  });

  it('rejects every governed leaf replaced by a value of each other JSON kind (exhaustive)', () => {
    for (const site of LEAF_SITES) {
      for (const kind of otherKinds(site.value)) {
        const replacement = KIND_REPRESENTATIVES[kind];
        assertRejectedMutation(
          withValueAt(site.record, site.path, replacement),
          () => `${site.label}${pointerOf(site.path)} = ${JSON.stringify(replacement)}`,
        );
      }
    }
  });

  it('rejects an unknown member added to every governed object (exhaustive)', () => {
    for (const site of OBJECT_SITES) {
      assertRejectedMutation(
        withValueAt(site.record, [...site.path, 'x_unknown'], 1),
        () => `${site.label}${pointerOf(site.path)}/x_unknown`,
      );
    }
  });

  it('rejects every record without one of its top-level required members (exhaustive)', () => {
    for (const site of REMOVAL_SITES) {
      assertRejectedMutation(
        withoutField(site.record, String(site.path[0])),
        () => `${site.label} without ${pointerOf(site.path)}`,
      );
    }
  });

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
