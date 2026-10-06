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
 * Returns a deep copy of a record with the value at an existing JSON path replaced, e.g.
 * `withPath(manifest, ['safety', 'region'], 'eu-west-1')`. Throws, naming the whole path, as
 * soon as any segment is missing: it never adds a member, so a typo cannot pass as a mutation.
 */
export function withPath(record: object, path: readonly (string | number)[], value: JsonFragment): JsonObject {
  const copy: unknown = structuredClone(asJson(record));
  const { parent, key } = targetOf(copy, path);
  parent[key] = value;
  return copy as JsonObject;
}

/**
 * Returns a deep copy of a record without the object member at an existing JSON path, e.g.
 * `withoutPath(manifest, ['configuration', 0, 'canonical_json'])`. Throws like `withPath`, and
 * when the path addresses an array item (removing one would shift the others).
 */
export function withoutPath(record: object, path: readonly (string | number)[]): JsonObject {
  const copy: unknown = structuredClone(asJson(record));
  const { parent, key } = targetOf(copy, path);
  if (Array.isArray(parent)) {
    throw new Error(`path ${JSON.stringify(path)} addresses an array item; expected an object member`);
  }
  Reflect.deleteProperty(parent, key);
  return copy as JsonObject;
}

interface PathTarget {
  readonly parent: Record<string | number, unknown>;
  readonly key: string | number;
}

function targetOf(root: unknown, path: readonly (string | number)[]): PathTarget {
  const key = path.at(-1);
  const parent = path.slice(0, -1).reduce<unknown>((node, segment) => memberOf(node, segment, path), root);
  if (key === undefined || !hasMember(parent, key)) {
    throw missingPath(path);
  }
  return { parent, key };
}

function memberOf(node: unknown, key: string | number, path: readonly (string | number)[]): unknown {
  if (!hasMember(node, key)) {
    throw missingPath(path);
  }
  return node[key];
}

function hasMember(node: unknown, key: string | number): node is Record<string | number, unknown> {
  return typeof node === 'object' && node !== null && Object.hasOwn(node, key);
}

function missingPath(path: readonly (string | number)[]): Error {
  return new Error(`path ${JSON.stringify(path)} does not exist in the record; expected an existing property path`);
}
