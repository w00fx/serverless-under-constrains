// AC-RUA-046 totality of the group-C validator on untrusted input (Owner amendment A-05): every
// value `JSON.parse` accepts is judged, never a crash. Package bytes reach the validator through
// evidence ingestion (BR-RUA-043), and the Lambda Node runtime decodes events with `JSON.parse`,
// so three hostile shapes are regression cases at this boundary:
// - deep nesting (100,000 levels): before the WP-00 round-1 kernel fix (dbcec34), two towers in
//   any group-C `uniqueItems` array threw `RangeError: Maximum call stack size exceeded` out of
//   the recursive kernel `sameJsonValue` (WP-03 review round 2, engineering finding 2);
// - non-finite numbers: `JSON.parse('1e400')` is `Infinity`;
// - inherited member names (`__proto__`, `constructor`, `toString`, ...): Owner amendment A-07,
//   every group-C object closes with `additionalProperties: false`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isJsonArray, isJsonObject } from '../../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import { RECORD_TYPE_GROUPS } from '../../../../src/record-contract/record-types.ts';
import type { GroupCRecordType } from '../../../../src/record-contract/records/group-c/record-map.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import type { RecordValidation, SchemaViolation } from '../../../../src/record-contract/schema-registry.ts';
import { parsedTower } from '../../../support/kernel/deep-json.ts';
import { leavesOf, objectPathsOf, pointerOf, withValueAt } from '../group-b/support/json-paths.ts';
import type { JsonPath } from '../group-b/support/json-paths.ts';
import { toJson } from '../group-b/support/record-builders.ts';
import { resolvePointer } from '../group-b/support/schema-reading.ts';
import { CANONICAL_EXAMPLES, GROUP_C_EXAMPLES } from './examples/group-c-examples.ts';
import { treatmentPassOracleResult } from './examples/oracle-examples.ts';
import { INHERITED_MEMBER_NAMES, NON_FINITE_NUMBERS } from './support/hostile-json.ts';
import { isFreeForm } from './support/json-scope.ts';
import { groupCSchemaOf } from './support/schema-reading.ts';

/** A-05: deep-nesting regression cases use at least 100,000 levels. */
const TOWER_DEPTH = 100_000;

interface UniqueItemsSite {
  /** The schema file and the JSON Pointer of the array schema that declares `uniqueItems`. */
  readonly recordType: GroupCRecordType;
  readonly schemaPointer: string;
  /** The example that holds such an array, and the array's path in it. */
  readonly example: () => JsonObject;
  readonly path: JsonPath;
}

/**
 * Every group-C array schema that declares `uniqueItems` (the kernel duplicate check), with an
 * example array it governs. The first case checks this list against the schemas themselves.
 */
const UNIQUE_ITEMS_SITES: readonly UniqueItemsSite[] = [
  site('cleanup_result', '/properties/stopped_durable_execution_arns', ['stopped_durable_execution_arns']),
  site('cleanup_result', '/properties/deleted_dlq_message_ids', ['deleted_dlq_message_ids']),
  site('cli_result', '/properties/written_paths', ['written_paths']),
  site('comparison_assessment', '/$defs/equality_projection/properties/compared_fields', [
    'equality_projections',
    0,
    'compared_fields',
  ]),
  site('leak_audit_result', '/$defs/surface_observation/properties/observed', ['passes', 0, 'surfaces', 0, 'observed']),
  site('operational_recovery_record', '/properties/steps_run', ['steps_run']),
  {
    recordType: 'oracle_result',
    schemaPointer: '/$defs/condition_result/properties/affected_by',
    example: (): JsonObject => toJson(treatmentPassOracleResult()),
    path: ['treatment_condition_results', 0, 'affected_by'],
  },
  site('oracle_result', '/properties/clock_assumption_refs', ['clock_assumption_refs']),
  site('oracle_revision_check', '/$defs/rule_coverage/properties/case_ids', ['rule_coverage', 0, 'case_ids']),
  site('oracle_revision_check', '/properties/uncovered', ['uncovered']),
  site('transport_probe_result', '/$defs/condition_result/properties/affected_by', [
    'condition_results',
    0,
    'affected_by',
  ]),
  site('transport_probe_result', '/properties/clock_assumption_refs', ['clock_assumption_refs']),
];

/** A uniqueItems site whose array lives in the canonical example of its record type. */
function site(recordType: GroupCRecordType, schemaPointer: string, path: JsonPath): UniqueItemsSite {
  return { recordType, schemaPointer, example: (): JsonObject => toJson(CANONICAL_EXAMPLES[recordType]()), path };
}

// Sweep sizes over the examples, pinned so a shrinking example set fails instead of passing on less.
const CANONICAL_GOVERNED_LEAVES = 751;
const FREE_FORM_LEAVES = 403;
const NUMERIC_MEMBERS = 140;
const GOVERNED_OBJECTS = 693;

const validator = createRecordValidator();
const ARRAY_TOWER = parsedTower('array', TOWER_DEPTH);
const OBJECT_TOWER = parsedTower('object', TOWER_DEPTH);
const MIXED_TOWER = parsedTower('mixed', TOWER_DEPTH);
const TOWERS: readonly (readonly [string, JsonValue])[] = [
  ['array tower', ARRAY_TOWER],
  ['object tower', OBJECT_TOWER],
  ['mixed tower', MIXED_TOWER],
];

const CANONICAL_JSON: readonly (readonly [GroupCRecordType, JsonObject])[] = RECORD_TYPE_GROUPS['group-c'].map(
  (recordType) => [recordType, toJson(CANONICAL_EXAMPLES[recordType]())] as const,
);
const EXAMPLE_JSON = GROUP_C_EXAMPLES.map((example) => ({ label: example.label, json: toJson(example.record) }));

/** Validates, returning the thrown error instead of letting it escape the test. */
function validationOf(value: JsonValue): RecordValidation | Error {
  try {
    return validator.validate(value);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Asserts validate returns (never throws) and rejects with a violation at or under `pointer`. */
function assertRejectedAt(value: JsonValue, label: string, pointer: string): readonly SchemaViolation[] {
  const outcome = validationOf(value);
  if (outcome instanceof Error) {
    assert.fail(`${label}: validate threw ${outcome.name}: ${outcome.message}`);
  }
  if (outcome.valid) {
    assert.fail(`${label}: expected a rejection at ${pointer}, got a valid record`);
  }
  assert.ok(
    outcome.violations.some((violation) => `${violation.instance_path}/`.startsWith(`${pointer}/`)),
    `${label}: expected a violation at ${pointer}, got ${String(outcome.violations.length)} elsewhere`,
  );
  return outcome.violations;
}

/** Copies `record` with `name` added as an own member of the object at `path`. */
function withOwnMember(record: JsonObject, path: JsonPath, name: string): JsonValue {
  return withValueAt(record, [...path, name], 1);
}

/** JSON Pointers of every schema node that declares `uniqueItems: true`, walked iteratively. */
function uniqueItemsPointers(recordType: GroupCRecordType): readonly string[] {
  const found: string[] = [];
  const pending: (readonly [JsonValue, string])[] = [[groupCSchemaOf(recordType), '']];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [node, pointer] = next;
    if (isJsonArray(node)) {
      node.forEach((child, index) => pending.push([child, `${pointer}/${String(index)}`]));
      continue;
    }
    if (!isJsonObject(node)) {
      continue;
    }
    if (node['uniqueItems'] === true) {
      found.push(pointer);
    }
    Object.entries(node).forEach(([key, child]) => pending.push([child, `${pointer}/${key}`]));
  }
  return found;
}

describe('AC-RUA-046 group-C validation is total over hostile JSON (A-05, A-07)', () => {
  it('lists every uniqueItems array of the group-C schemas', () => {
    const declared = RECORD_TYPE_GROUPS['group-c'].flatMap((recordType) =>
      uniqueItemsPointers(recordType).map((pointer) => `${recordType}#${pointer}`),
    );
    assert.deepEqual(
      declared.toSorted(),
      UNIQUE_ITEMS_SITES.map((entry) => `${entry.recordType}#${entry.schemaPointer}`).toSorted(),
    );
  });

  it('rejects 100,000-level towers, alone, duplicated or distinct, at every uniqueItems array', () => {
    const arrays: readonly (readonly [string, JsonValue])[] = [
      ['one tower', [ARRAY_TOWER]],
      ['two equal towers', [ARRAY_TOWER, ARRAY_TOWER]],
      ['two equal object towers', [OBJECT_TOWER, OBJECT_TOWER]],
      ['two distinct towers', [ARRAY_TOWER, MIXED_TOWER]],
    ];
    for (const entry of UNIQUE_ITEMS_SITES) {
      const record = entry.example();
      const pointer = pointerOf(entry.path);
      assert.equal(validator.validate(record).valid, true, `${entry.recordType} example is valid`);
      assert.ok(isJsonArray(resolvePointer(record, pointer)), `${entry.recordType}${pointer} is an array`);
      for (const [label, value] of arrays) {
        assertRejectedAt(withValueAt(record, entry.path, value), `${entry.recordType}${pointer} ${label}`, pointer);
      }
    }
  });

  it('rejects a 100,000-level tower in place of any governed leaf of every canonical example', () => {
    let checked = 0;
    for (const [recordType, record] of CANONICAL_JSON) {
      for (const leaf of leavesOf(record).filter((candidate) => !isFreeForm(candidate.path))) {
        const [label, tower] = TOWERS[checked % TOWERS.length] ?? ['array tower', ARRAY_TOWER];
        const pointer = pointerOf(leaf.path);
        assertRejectedAt(withValueAt(record, leaf.path, tower), `${recordType}${pointer} ${label}`, pointer);
        checked += 1;
      }
    }
    assert.equal(checked, CANONICAL_GOVERNED_LEAVES, 'every governed leaf of the 23 canonical examples');
  });

  it('judges a 100,000-level tower in a free-form value without throwing', () => {
    const freeForm = EXAMPLE_JSON.flatMap(({ label, json }) =>
      leavesOf(json)
        .filter((leaf) => isFreeForm(leaf.path))
        .map((leaf) => ({ label, json, path: leaf.path })),
    );
    assert.equal(freeForm.length, FREE_FORM_LEAVES, 'every free-form leaf of the examples');
    for (const site of freeForm) {
      const outcome = validationOf(withValueAt(site.json, site.path, MIXED_TOWER));
      assert.ok(
        !(outcome instanceof Error),
        `${site.label}${pointerOf(site.path)}: validate threw ${outcome instanceof Error ? outcome.message : ''}`,
      );
    }
  });

  it('rejects a non-finite number at every numeric member of every example', () => {
    const numeric = EXAMPLE_JSON.flatMap(({ label, json }) =>
      leavesOf(json)
        .filter((leaf) => typeof leaf.value === 'number' && !isFreeForm(leaf.path))
        .map((leaf) => ({ label, json, path: leaf.path })),
    );
    for (const { label, json, path } of numeric) {
      const pointer = pointerOf(path);
      NON_FINITE_NUMBERS.forEach((value) =>
        assertRejectedAt(withValueAt(json, path, value), `${label}${pointer} = ${String(value)}`, pointer),
      );
    }
    assert.equal(numeric.length, NUMERIC_MEMBERS, 'every governed numeric member of the examples');
  });

  it('rejects every inherited member name at the root and at every governed object (A-07)', () => {
    const objects = EXAMPLE_JSON.flatMap(({ label, json }) =>
      objectPathsOf(json)
        .filter((path) => !isFreeForm(path))
        .flatMap((path) => INHERITED_MEMBER_NAMES.map((name) => ({ label, json, path, name }))),
    );
    for (const { label, json, path, name } of objects) {
      const pointer = pointerOf(path);
      const violations = assertRejectedAt(withOwnMember(json, path, name), `${label}${pointer} + own ${name}`, pointer);
      assert.ok(
        violations.some(
          (violation) => violation.instance_path === pointer && violation.keyword === 'additionalProperties',
        ),
        `${label}${pointer} + own ${name}: expected additionalProperties at ${pointer || 'the root'}`,
      );
    }
    assert.equal(
      objects.length,
      GOVERNED_OBJECTS * INHERITED_MEMBER_NAMES.length,
      'six names at every governed object',
    );
  });
});
