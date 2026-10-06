// AC-RUA-046 (group C): the catalogue rows 66-88 each have exactly one schema and one record
// module; the schemas follow the catalogue conventions; the closed vocabularies the TypeScript
// modules export are the ones the schemas enforce, including the fixed order of every tuple.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { EVENT_RECORD_TYPES, RECORD_TYPES, RECORD_TYPE_GROUPS } from '../../../../src/record-contract/record-types.ts';
import type { GroupCRecordType } from '../../../../src/record-contract/records/group-c/record-map.ts';
import { findSchemaConventionViolations } from '../../../../src/record-contract/schema-conventions.ts';
import { listSchemaFiles } from '../../../../src/record-contract/schema-registry.ts';
import { groupBValidator } from '../../../support/record-contract/group-b-validation.ts';
import { resolvePointer, withValueAt } from '../../../support/record-contract/json-paths.ts';
import { toJson } from '../../../support/record-contract/record-builders.ts';
import { CANONICAL_EXAMPLES, GROUP_C_EXAMPLES } from './examples/group-c-examples.ts';
import { groupCSchemaOf } from './support/schema-reading.ts';
import { ORDER_SITES, VOCABULARY_SITES } from './support/vocabulary-sites.ts';

const GROUP_C: readonly GroupCRecordType[] = RECORD_TYPE_GROUPS['group-c'];
const RECORD_MODULE_DIRECTORY = fileURLToPath(
  new URL('../../../../src/record-contract/records/group-c/', import.meta.url),
);
const SHARED_MODULES = ['record-map.ts', 'shared-shapes.ts', 'vocabulary.ts'];
/** Each `$defs` shape that several group-C schemas restate, with the number of schemas carrying it. */
const RESTATED_DEFINITIONS: readonly (readonly [string, number])[] = [
  ['artifact_ref', 7],
  ['condition_result', 2],
  ['trial_result', 2],
];

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('AC-RUA-046 group C catalogue', () => {
  it('lists exactly the 23 group-C record types, one schema each, within 91 catalogued names', () => {
    const listed = listSchemaFiles()
      .filter((file) => file.relative_path.startsWith('group-c/'))
      .map((file) => file.record_type);
    assert.deepEqual(listed, GROUP_C.toSorted());
    assert.equal(GROUP_C.length, 23);
    assert.equal(RECORD_TYPES.length, 91);
    const mapMatchesCatalogue: Equal<GroupCRecordType, (typeof RECORD_TYPE_GROUPS)['group-c'][number]> = true;
    assert.equal(mapMatchesCatalogue, true);
  });

  it('every group-C schema follows the catalogue conventions and names its catalogue row', () => {
    GROUP_C.forEach((recordType, index) => {
      const schema = groupCSchemaOf(recordType);
      assert.deepEqual(findSchemaConventionViolations(recordType, schema), [], recordType);
      assert.equal(resolvePointer(schema, '/title'), `${recordType} (catalogue group C, row ${String(66 + index)})`);
    });
  });

  it('no group-C record is a journal event', () => {
    const events: readonly string[] = EVENT_RECORD_TYPES;
    assert.deepEqual(
      GROUP_C.filter((recordType) => events.includes(recordType)),
      [],
    );
  });

  it('has one record module per type plus the shared vocabulary, shapes and type map', async () => {
    const modules = readdirSync(RECORD_MODULE_DIRECTORY).toSorted();
    assert.deepEqual(modules, [...GROUP_C.map((recordType) => `${recordType}.ts`), ...SHARED_MODULES].toSorted());
    for (const name of modules.filter((module) => module !== 'vocabulary.ts')) {
      const loaded = (await import(join(RECORD_MODULE_DIRECTORY, name))) as Readonly<Record<string, unknown>>;
      assert.deepEqual(Object.keys(loaded), [], `${name} is type-only`);
    }
  });

  it('every closed vocabulary is the enum its schema enforces', () => {
    assert.equal(VOCABULARY_SITES.length, 151);
    for (const [values, recordType, pointer] of VOCABULARY_SITES) {
      assert.deepEqual(resolvePointer(groupCSchemaOf(recordType), pointer), [...values], `${recordType}#${pointer}`);
    }
    const covered = new Set(VOCABULARY_SITES.map(([, recordType]) => recordType));
    assert.deepEqual(
      GROUP_C.filter((recordType) => !covered.has(recordType)),
      [],
      'every group-C type has a closed vocabulary site',
    );
  });

  it('every fixed-order tuple pins each position to its vocabulary, in order', () => {
    for (const [values, recordType, pointer, member] of ORDER_SITES) {
      const schema = groupCSchemaOf(recordType);
      assert.equal(resolvePointer(schema, `${pointer}/minItems`), values.length, `${recordType}${pointer} minItems`);
      assert.equal(resolvePointer(schema, `${pointer}/maxItems`), values.length, `${recordType}${pointer} maxItems`);
      assert.equal(resolvePointer(schema, `${pointer}/items`), false, `${recordType}${pointer} closed`);
      const pinned = values.map((_value, index) =>
        resolvePointer(schema, `${pointer}/prefixItems/${String(index)}/allOf/1/properties/${member}/const`),
      );
      assert.deepEqual(pinned, [...values], `${recordType}${pointer} ${member}`);
    }
  });

  it('restates each shared $defs shape identically in every schema that carries it', () => {
    // The schemas may reference only `_defs.schema.json` and their own `$defs`, so shared shapes
    // are restated per file; a hand edit to one copy must fail here instead of drifting.
    const copiesOf = (definition: string): readonly JsonValue[] =>
      GROUP_C.map((recordType) => resolvePointer(groupCSchemaOf(recordType), `/$defs/${definition}`)).filter(
        (copy): copy is JsonValue => copy !== undefined,
      );
    for (const [definition, count] of RESTATED_DEFINITIONS) {
      const copies = copiesOf(definition);
      assert.equal(copies.length, count, `${definition} copies`);
      for (const copy of copies) {
        assert.deepEqual(copy, copies[0], `${definition} copies are identical`);
      }
    }
    // Index entries differ only in their self-exclusion clauses after the shared path rule.
    const entries = copiesOf('index_entry').map((copy) =>
      withValueAt(copy, ['properties', 'artifact_path', 'allOf'], undefined),
    );
    assert.equal(entries.length, 3);
    for (const entry of entries) {
      assert.deepEqual(entry, entries[0], 'index_entry copies are identical but for their exclusions');
    }
    for (const copy of copiesOf('index_entry')) {
      assert.deepEqual(resolvePointer(copy, '/properties/artifact_path/allOf/0'), {
        $ref: '_defs.schema.json#/$defs/package_relative_path',
      });
    }
  });

  it('has a valid canonical example of every type, validated as that type', () => {
    for (const recordType of GROUP_C) {
      const record = toJson(CANONICAL_EXAMPLES[recordType]());
      assert.equal(record['record_type'], recordType);
      assert.equal(groupBValidator.validateAs(recordType, record).valid, true, recordType);
    }
    const covered = new Set(GROUP_C_EXAMPLES.map((example) => example.record.record_type));
    assert.equal(covered.size, GROUP_C.length);
  });
});
