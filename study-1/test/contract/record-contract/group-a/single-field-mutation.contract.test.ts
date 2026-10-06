// AC-RUA-046 (group A) property of design §12.5, "record validators (each group): a valid
// generated record mutated in one field is rejected". The valid records are the canonical
// examples and the other branch of each conditional rule (support/canonical-examples.ts and
// support/branch-examples.ts). A
// mutation site is any governed leaf, at any depth, replaced by a value of another JSON kind;
// any governed object, given an unknown member; any top-level required member, removed; or any
// governed leaf given a malformed value of its own kind (a negative, fractional or unsafe number,
// the other boolean, a string padded with whitespace), which reaches the pattern, enum, const and
// bound rules at every depth. The open members the schemas deliberately accept, free text
// included, are listed once, in support/json-scope.ts.
// Each mutation kind runs twice: an exhaustive sweep with one fixed value per JSON kind over
// every site (here), then a fast-check property with generated values
// (test/fuzz/record-contract/group-a/single-field-mutation.fuzz.test.ts, Owner amendment A-11).
// Both draw their sites and kind rules from support/single-field-mutations.ts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import { DEFAULT_SCHEMA_ROOT, listSchemaFiles } from '../../../../src/record-contract/schema-registry.ts';
import { pointerOf, withValueAt } from '../../../support/record-contract/json-paths.ts';
import type { MutationSite } from './support/mutation-sites.ts';
import {
  assertRejectedMutation,
  EXAMPLES,
  LEAF_SITES,
  OBJECT_SITES,
  otherKinds,
  sameKindBreaks,
} from './support/single-field-mutations.ts';
import type { JsonKind } from './support/single-field-mutations.ts';
import { catalogueValidator, withoutField } from './support/validation-assertions.ts';

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

const REMOVAL_SITES: readonly MutationSite[] = EXAMPLES.flatMap(({ name, record }) =>
  requiredOf(record, name).map((member) => ({ label: name, record, path: [member], value: null })),
);

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

describe('record validators (group A)', () => {
  it('generates over every governed leaf and object of the 19 record types', () => {
    assert.equal(new Set(EXAMPLES.map(({ record }) => record['record_type'])).size, 19);
    assert.equal(EXAMPLES.length, 36);
    assert.equal(LEAF_SITES.length, 755);
    assert.equal(OBJECT_SITES.length, 151);
    assert.equal(REMOVAL_SITES.length, 343);
    // Nested sites are generated, not only top-level members.
    assert.ok(LEAF_SITES.some((site) => pointerOf(site.path) === '/timing/provider_client_deadline_ms'));
    assert.ok(LEAF_SITES.some((site) => pointerOf(site.path) === '/files/1/sha256'));
    assert.ok(OBJECT_SITES.some((site) => pointerOf(site.path) === '/configuration_projections/0/resources/0'));
    // The branch examples are swept too: the validation stack's variant tag, the probe stack and a
    // validation identity.
    const labelled = (label: string, pointer: string): boolean =>
      LEAF_SITES.some((site) => site.label === label && pointerOf(site.path) === pointer);
    assert.ok(labelled('resource_manifest (variant validation stack)', '/ownership_tags/5/value'));
    assert.ok(labelled('resource_manifest (transport probe stack)', '/transport_probe_id'));
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

  it('rejects every governed leaf given a malformed value of its own kind (exhaustive)', () => {
    let mutations = 0;
    for (const site of LEAF_SITES) {
      for (const replacement of sameKindBreaks(site)) {
        mutations += 1;
        assertRejectedMutation(
          withValueAt(site.record, site.path, replacement),
          () => `${site.label}${pointerOf(site.path)} = ${JSON.stringify(replacement)}`,
        );
      }
    }
    assert.ok(mutations > LEAF_SITES.length, `${String(mutations)} same-kind mutations`);
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
});
