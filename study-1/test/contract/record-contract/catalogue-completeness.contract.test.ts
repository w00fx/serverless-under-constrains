// AC-RUA-046 catalogue completeness (design §6; addendum §3: 90 record types, the 88 catalogue
// rows plus the warm-up pair): every catalogued record type, across groups A, B and C, has
// exactly one JSON Schema in its group directory, one TypeScript interface module in its group,
// and one canonical example that the real validator accepts as that type. No schema file or
// record module exists for a name outside the catalogue.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import {
  RECORD_GROUPS,
  RECORD_TYPES,
  RECORD_TYPE_GROUPS,
  recordGroupOf,
} from '../../../src/record-contract/record-types.ts';
import type { RecordType } from '../../../src/record-contract/record-types.ts';
import {
  DEFAULT_SCHEMA_ROOT,
  createRecordValidator,
  listSchemaFiles,
} from '../../../src/record-contract/schema-registry.ts';
import type { RecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { CANONICAL_EXAMPLES as GROUP_A_EXAMPLES } from './group-a/support/canonical-examples.ts';
import { CANONICAL_EXAMPLES as GROUP_B_EXAMPLES } from './group-b/examples/group-b-examples.ts';
import { toJson } from './group-b/support/record-builders.ts';
import { CANONICAL_EXAMPLES as GROUP_C_EXAMPLES } from './group-c/examples/group-c-examples.ts';

const RECORD_MODULE_ROOT = fileURLToPath(new URL('../../../src/record-contract/records/', import.meta.url));
const SCHEMA_SUFFIX = '.schema.json';
const SHARED_MODULES: Readonly<Record<string, readonly string[]>> = {
  'group-a': [],
  'group-b': ['record-map.ts', 'shared-shapes.ts', 'vocabulary.ts'],
  'group-c': ['record-map.ts', 'shared-shapes.ts', 'vocabulary.ts'],
};

/**
 * Asserts the validator rejects `relabelled` (an example of `source` renamed as `other`) because of
 * its members, not only because of `record_type`.
 */
function assertMembersRejectedAs(
  validator: RecordValidator,
  other: RecordType,
  relabelled: JsonObject,
  source: RecordType,
): void {
  const outcome = validator.validate(relabelled);
  if (outcome.valid) {
    assert.fail(`${source} payload is valid as ${other}; expected a rejection`);
  }
  const paths = outcome.violations.map((violation) => violation.instance_path || '/');
  assert.ok(
    paths.some((path) => path !== '/record_type'),
    `${source} payload as ${other}: expected a member violation, got ${paths.join(', ')}`,
  );
}

// One canonical example per catalogued type, keyed by type; each group's tuple indexes its
// own typed example table, so a missing example fails to compile.
const CANONICAL_EXAMPLES: ReadonlyMap<RecordType, () => JsonObject> = new Map<RecordType, () => JsonObject>([
  ...RECORD_TYPE_GROUPS['group-a'].map((recordType) => [recordType, GROUP_A_EXAMPLES[recordType]] as const),
  ...RECORD_TYPE_GROUPS['group-b'].map(
    (recordType) => [recordType, (): JsonObject => toJson(GROUP_B_EXAMPLES[recordType]())] as const,
  ),
  ...RECORD_TYPE_GROUPS['group-c'].map(
    (recordType) => [recordType, (): JsonObject => toJson(GROUP_C_EXAMPLES[recordType]())] as const,
  ),
]);

/** The canonical example of any catalogued type, as the JSON a reader would parse. */
function canonicalExampleOf(recordType: RecordType): JsonObject {
  const build = CANONICAL_EXAMPLES.get(recordType);
  if (build === undefined) {
    throw new Error(`no canonical example for ${recordType}; expected one per catalogued record type`);
  }
  return build();
}

describe('AC-RUA-046 catalogue completeness over all 90 record types', () => {
  it('catalogues 90 distinct record types in three groups', () => {
    assert.equal(RECORD_TYPES.length, 90);
    assert.equal(new Set(RECORD_TYPES).size, 90);
    assert.deepEqual(
      RECORD_GROUPS.map((group) => RECORD_TYPE_GROUPS[group].length),
      [18, 49, 23],
    );
    assert.deepEqual(
      RECORD_GROUPS.flatMap((group) => RECORD_TYPE_GROUPS[group]),
      [...RECORD_TYPES],
    );
  });

  it('every type has exactly one schema, in its group directory, and no schema is stray', () => {
    const listed = listSchemaFiles();
    assert.deepEqual(listed.map((file) => file.record_type).toSorted(), RECORD_TYPES.toSorted());
    for (const file of listed) {
      assert.equal(file.relative_path, `${recordGroupOf(file.record_type)}/${file.record_type}${SCHEMA_SUFFIX}`);
    }
    for (const group of RECORD_GROUPS) {
      const names = readdirSync(join(DEFAULT_SCHEMA_ROOT, group)).filter((name) => !name.startsWith('.'));
      const expected: readonly string[] = RECORD_TYPE_GROUPS[group].map(
        (recordType) => `${recordType}${SCHEMA_SUFFIX}`,
      );
      assert.deepEqual(names.toSorted(), expected.toSorted(), `${group} schema directory`);
    }
  });

  it('every type has one interface module in its group, and no module is stray', () => {
    for (const group of RECORD_GROUPS) {
      const modules = readdirSync(join(RECORD_MODULE_ROOT, group)).filter((name) => !name.startsWith('.'));
      const expected = [
        ...RECORD_TYPE_GROUPS[group].map((recordType) => `${recordType}.ts`),
        ...(SHARED_MODULES[group] ?? []),
      ];
      assert.deepEqual(modules.toSorted(), expected.toSorted(), `${group} record modules`);
    }
  });

  it('every type has a canonical example the validator accepts as that type', () => {
    assert.equal(CANONICAL_EXAMPLES.size, 90);
    const validator = createRecordValidator();
    for (const recordType of RECORD_TYPES) {
      const example = canonicalExampleOf(recordType);
      assert.equal(example['record_type'], recordType, `${recordType} example names its type`);
      const asItsType = validator.validateAs(recordType, example);
      assert.equal(
        asItsType.valid,
        true,
        `${recordType}: ${JSON.stringify(asItsType.valid ? [] : asItsType.violations)}`,
      );
      assert.equal(validator.validate(example).valid, true, `${recordType} by discovery`);
    }
  });

  it("a canonical example's payload is never valid under another type's schema", () => {
    // The example is relabelled as the other type, so that type's schema judges every member;
    // `validateAs(other, example)` would stop at the record_type pre-check before any schema runs.
    const validator = createRecordValidator();
    let checked = 0;
    for (const recordType of RECORD_TYPES) {
      const example = canonicalExampleOf(recordType);
      for (const other of RECORD_TYPES.filter((candidate) => candidate !== recordType)) {
        assertMembersRejectedAs(validator, other, { ...example, record_type: other }, recordType);
        checked += 1;
      }
    }
    assert.equal(checked, 90 * 89);
  });
});
