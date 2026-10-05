// Assertions over the committed catalogue: the real schema registry (Ajv 2020-12 strict, the
// CAP-RUA vocabulary) reading the group A schemas from disk through the node adapter. Each
// violation is compared as "<instance_path> <keyword>", the stable part of an Ajv error.

import assert from 'node:assert/strict';

import type { JsonObject, JsonValue } from '../../../../../src/record-contract/primitives.ts';
import type { RecordType } from '../../../../../src/record-contract/record-types.ts';
import { createRecordValidator } from '../../../../../src/record-contract/schema-registry.ts';
import type { RecordValidation } from '../../../../../src/record-contract/schema-registry.ts';

export const catalogueValidator = createRecordValidator();

/** Views a typed record as the parsed JSON the validator receives. */
export function asJson(record: object): JsonObject {
  return record as unknown as JsonObject;
}

/** The "<instance_path> <keyword>" pairs of a validation; empty when the record is valid. */
export function violationsOf(result: RecordValidation): readonly string[] {
  return result.valid ? [] : result.violations.map((violation) => `${violation.instance_path} ${violation.keyword}`);
}

/** Asserts that a record validates as its declared record type. */
export function assertAccepted(record: object, label: string): void {
  const json = asJson(record);
  const declared = json['record_type'];
  assert.equal(typeof declared, 'string', `${label}: the record must declare its record_type`);
  assert.deepEqual(violationsOf(catalogueValidator.validateAs(declared as RecordType, json)), [], label);
}

/** Asserts that a record is rejected and that one of its violations is `expected`. */
export function assertRejected(record: JsonValue | object, expected: string, label: string): void {
  const violations = violationsOf(catalogueValidator.validate(record as JsonValue));
  assert.ok(violations.length > 0, `${label}: expected a rejection with "${expected}", but the record is valid`);
  assert.ok(
    violations.includes(expected),
    `${label}: expected violation "${expected}", got ${JSON.stringify(violations)}`,
  );
}

/**
 * A JSON value or a typed record fragment (an interface from `records/group-a`), which is
 * JSON-shaped by construction but lacks the index signature `JsonValue` requires.
 */
export type JsonFragment = JsonValue | object;

/** Returns a copy of a record with one top-level property set (or added), e.g. `withField(payment(), 'currency', 'USD')`. */
export function withField(record: object, field: string, value: JsonFragment): JsonObject {
  return { ...asJson(record), [field]: value as JsonValue };
}

/** Returns a copy of a record without one top-level property. */
export function withoutField(record: object, field: string): JsonObject {
  return Object.fromEntries(Object.entries(asJson(record)).filter(([name]) => name !== field));
}

/**
 * Returns a deep copy of a record with the value at a JSON path replaced, e.g.
 * `withPath(manifest, ['safety', 'region'], 'eu-west-1')`. Throws when the path does not exist.
 */
export function withPath(record: object, path: readonly (string | number)[], value: JsonFragment): JsonObject {
  const copy = structuredClone(asJson(record)) as Record<string, unknown>;
  const parentPath = path.slice(0, -1);
  const last = path.at(-1);
  const parent = parentPath.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], copy);
  if (last === undefined || typeof parent !== 'object' || parent === null || !(last in parent)) {
    throw new Error(`path ${JSON.stringify(path)} does not exist in the record; expected an existing property path`);
  }
  (parent as Record<string | number, unknown>)[last] = value;
  return copy as JsonObject;
}
