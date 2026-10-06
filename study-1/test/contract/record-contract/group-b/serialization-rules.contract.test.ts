// AC-RUA-046 serialization rules (BR-RUA-033) proven over every group-B example: each rule is
// applied to every leaf or member it governs, so a schema that loosens one field anywhere in
// the 49 types fails here. The case names are the criterion's.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isDecimalString } from '../../../../src/record-contract/decimal.ts';
import { isSha256Hex } from '../../../../src/record-contract/digests.ts';
import { isUuid4 } from '../../../../src/record-contract/identifiers.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import { isUtcMillis } from '../../../../src/record-contract/timestamps.ts';
import { GROUP_B_EXAMPLES } from './examples/group-b-examples.ts';
import { assertAccepted, assertRejected } from './support/group-b-validation.ts';
import { leavesOf, objectPathsOf, pointerOf, textOf, withMember, withValueAt } from './support/json-paths.ts';
import type { JsonLeaf } from './support/json-paths.ts';
import type { RecordExample } from './support/record-example.ts';
import { toJson } from './support/record-builders.ts';

type LeafMutation = (value: JsonValue) => JsonValue;

interface ExampleJson {
  readonly example: RecordExample;
  readonly json: JsonObject;
}

const EXAMPLES: readonly ExampleJson[] = GROUP_B_EXAMPLES.map((example) => ({ example, json: toJson(example.record) }));

/**
 * Applies each mutation to every leaf `governs` selects (outside the verbatim members) in every
 * example, asserts each mutated record is rejected at that leaf, and returns how many leaves
 * were governed so a rule can never pass vacuously.
 */
function rejectEveryGovernedLeaf(
  governs: (value: JsonValue, leaf: JsonLeaf) => boolean,
  mutations: readonly LeafMutation[],
): number {
  let governed = 0;
  for (const { example, json } of EXAMPLES) {
    const leaves = leavesOf(json).filter(
      (leaf) => governs(leaf.value, leaf) && !example.verbatim.includes(String(leaf.path[0])),
    );
    governed += leaves.length;
    for (const [leaf, mutate] of leaves.flatMap((leaf) => mutations.map((mutate) => [leaf, mutate] as const))) {
      const mutated = mutate(leaf.value);
      const label = `${example.label}${pointerOf(leaf.path)} = ${JSON.stringify(mutated)}`;
      assertRejected(withValueAt(json, leaf.path, mutated), label, pointerOf(leaf.path));
    }
  }
  return governed;
}

function isNumber(value: JsonValue): boolean {
  return typeof value === 'number';
}

function isBoolean(value: JsonValue): boolean {
  return typeof value === 'boolean';
}

const UPPER_SNAKE_VALUE = /^[A-Z][A-Z0-9_]*[A-Z]$/;

/** Omitting a member is valid exactly when the example declares it optional. */
function assertOmission(example: RecordExample, json: JsonObject, key: string): void {
  const label = `${example.label} without ${key}`;
  if (example.optional.includes(key)) {
    assertAccepted(withMember(json, key, undefined), label);
    return;
  }
  assertRejected(withMember(json, key, undefined), label);
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

describe('AC-RUA-046 serialization rules over group B', () => {
  it('every example is valid after kernel serialization', () => {
    assert.equal(EXAMPLES.length, 68);
    for (const { example, json } of EXAMPLES) {
      assertAccepted(json, example.label);
    }
  });

  it('casing', () => {
    for (const { example, json } of EXAMPLES) {
      for (const key of Object.keys(json).filter((name) => name.includes('_'))) {
        const renamed = withMember(withMember(json, key, undefined), snakeToCamel(key), json[key] ?? null);
        assertRejected(renamed, `${example.label}: ${snakeToCamel(key)}`);
      }
      for (const path of objectPathsOf(json)) {
        assertRejected(withValueAt(json, [...path, 'extraField'], 1), `${example.label}${pointerOf(path)}/extraField`);
      }
      assertRejected(withMember(json, 'record_type', textOf(json['record_type'] ?? null).toUpperCase()), example.label);
    }
    const upperSnake = (value: JsonValue): boolean => typeof value === 'string' && UPPER_SNAKE_VALUE.test(value);
    assert.equal(rejectEveryGovernedLeaf(upperSnake, [(value): JsonValue => textOf(value).toLowerCase()]), 73);
  });

  it('millisecond UTC', () => {
    const mutations: readonly LeafMutation[] = [
      (value): JsonValue => textOf(value).replace(/\.\d{3}Z$/, 'Z'),
      (value): JsonValue => textOf(value).replace(/Z$/, '000Z'),
      (value): JsonValue => textOf(value).replace(/Z$/, '+00:00'),
      (value): JsonValue => textOf(value).replace(/Z$/, 'z'),
      (value): JsonValue => textOf(value).replace(/^\d{4}-\d{2}-\d{2}/, '2026-02-30'),
    ];
    assert.equal(rejectEveryGovernedLeaf(isUtcMillis, mutations), 92);
  });

  it('lowercase UUIDv4', () => {
    const mutations: readonly LeafMutation[] = [
      (value): JsonValue => textOf(value).toUpperCase().replace(/^0/, 'A'),
      (value): JsonValue => textOf(value).replaceAll('-', ''),
      (value): JsonValue => `${textOf(value).slice(0, 14)}1${textOf(value).slice(15)}`,
      (value): JsonValue => `{${textOf(value)}}`,
    ];
    assert.equal(rejectEveryGovernedLeaf(isUuid4, mutations), 336);
  });

  it('lowercase SHA-256 digests', () => {
    const mutations = [
      (value: JsonValue): JsonValue => textOf(value).toUpperCase(),
      (value: JsonValue): JsonValue => textOf(value).slice(1),
    ];
    assert.equal(rejectEveryGovernedLeaf(isSha256Hex, mutations), 127);
  });

  it('safe-integer amounts', () => {
    const mutations: readonly LeafMutation[] = [
      (value): JsonValue => Number(value) + 0.5,
      (value): JsonValue => textOf(value),
      (): JsonValue => -1,
      (): JsonValue => Number.MAX_SAFE_INTEGER + 1,
    ];
    assert.equal(rejectEveryGovernedLeaf(isNumber, mutations), 170);
  });

  it('decimal aggregates', () => {
    const elapsedNs = (value: JsonValue, leaf: JsonLeaf): boolean =>
      isDecimalString(value) && String(leaf.path.at(-1) ?? '').endsWith('_ns');
    const mutations: readonly LeafMutation[] = [
      (value): JsonValue => `0${textOf(value)}`,
      (): JsonValue => '-1',
      (): JsonValue => '1.5',
      (): JsonValue => '1e3',
      (value): JsonValue => Number(value),
    ];
    assert.equal(rejectEveryGovernedLeaf(elapsedNs, mutations), 6);
  });

  it('booleans are JSON booleans', () => {
    const mutations = [
      (value: JsonValue): JsonValue => textOf(value),
      (value: JsonValue): JsonValue => (value === true ? 1 : 0),
    ];
    assert.equal(rejectEveryGovernedLeaf(isBoolean, mutations), 18);
  });

  it('omitted versus null', () => {
    for (const { example, json } of EXAMPLES) {
      for (const member of [...example.optional, ...example.verbatim]) {
        assert.ok(member in json, `${example.label} declares ${member}, which the example must carry`);
      }
      for (const key of Object.keys(json)) {
        assertOmission(example, json, key);
        assertRejected(withMember(json, key, null), `${example.label} ${key}: null`, `/${key}`);
      }
      for (const leaf of leavesOf(json)) {
        assertRejected(withValueAt(json, leaf.path, null), `${example.label}${pointerOf(leaf.path)}: null`);
      }
    }
  });

  it('schema_version and record_type present', () => {
    for (const { example, json } of EXAMPLES) {
      assertRejected(withMember(json, 'schema_version', undefined), example.label, ' required');
      assertRejected(withMember(json, 'record_type', undefined), example.label, '/record_type record_type');
      for (const version of [0, 2, '1', 1.5]) {
        assertRejected(withMember(json, 'schema_version', version), `${example.label} v${String(version)}`);
      }
      const other = json['record_type'] === 'dispatch_started' ? 'attempt_registered' : 'dispatch_started';
      assertRejected(withMember(json, 'record_type', other), `${example.label} as ${other}`);
    }
  });
});
