// AC-RUA-046 (group A): every group A record type has its three catalogue parts (design §6): a
// JSON Schema that follows the catalogue conventions, a TypeScript interface module, and a
// canonical valid example that survives the BR-RUA-033 canonical serialization round trip.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { serializeRecordFile, structurallyEqual } from '../../../../src/record-contract/canonical-json.ts';
import { parseJsonDocument } from '../../../../src/record-contract/parsing.ts';
import { RECORD_TYPE_GROUPS } from '../../../../src/record-contract/record-types.ts';
import { findSchemaConventionViolations } from '../../../../src/record-contract/schema-conventions.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import { DEFAULT_SCHEMA_ROOT, listSchemaFiles } from '../../../../src/record-contract/schema-registry.ts';
import { CANONICAL_EXAMPLES, allValidExamples } from './support/canonical-examples.ts';
import { assertAccepted, catalogueValidator, violationsOf } from './support/validation-assertions.ts';

const GROUP_A = RECORD_TYPE_GROUPS['group-a'];

describe('AC-RUA-046 group A catalogue', () => {
  it('lists exactly one schema file per group A record type', () => {
    const groupA = listSchemaFiles().filter((file) => file.relative_path.startsWith('group-a/'));
    assert.deepEqual(
      groupA.map((file) => file.relative_path),
      GROUP_A.map((type) => `group-a/${type}.schema.json`).toSorted(),
    );
    assert.equal(GROUP_A.length, 18);
  });

  it('every group A schema follows the catalogue conventions', () => {
    for (const type of GROUP_A) {
      const parsed = parseJsonDocument(readFileSync(join(DEFAULT_SCHEMA_ROOT, 'group-a', `${type}.schema.json`)));
      assert.ok(parsed.ok, `${type}: the schema file is a JSON document`);
      assert.deepEqual(findSchemaConventionViolations(type, parsed.value), [], type);
    }
  });

  it('every group A record type has an interface module', async () => {
    for (const type of GROUP_A) {
      const module = (await import(`../../../../src/record-contract/records/group-a/${type}.ts`)) as Readonly<
        Record<string, unknown>
      >;
      assert.equal(typeof module, 'object', `${type}: records/group-a/${type}.ts loads`);
    }
  });

  it('has one canonical example per record type that validates as its own type', () => {
    assert.deepEqual(Object.keys(CANONICAL_EXAMPLES).toSorted(), [...GROUP_A].toSorted());
    for (const type of GROUP_A) {
      const example = CANONICAL_EXAMPLES[type]();
      assert.equal(example['record_type'], type);
      assertAccepted(example, `canonical ${type}`);
    }
  });

  it('every valid example survives the canonical serialization round trip unchanged', () => {
    for (const { name, record } of allValidExamples()) {
      const bytes = serializeRecordFile(record as unknown as StudyRecord);
      assert.equal(bytes.at(-1), 0x0a, `${name}: a record file ends with one newline`);
      const reparsed = parseJsonDocument(bytes);
      assert.ok(reparsed.ok, `${name}: the serialized bytes parse back`);
      assert.ok(structurallyEqual(reparsed.value, record), `${name}: structurally equal after the round trip`);
      assert.deepEqual(violationsOf(catalogueValidator.validate(reparsed.value)), [], `${name}: still valid`);
    }
  });

  it('refuses an example declared as another group A record type', () => {
    assert.deepEqual(violationsOf(catalogueValidator.validateAs('approved_decision', CANONICAL_EXAMPLES.payment())), [
      '/record_type const',
    ]);
  });
});
