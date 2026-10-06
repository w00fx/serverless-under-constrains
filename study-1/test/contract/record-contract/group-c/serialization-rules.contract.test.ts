// AC-RUA-046 serialization rules (BR-RUA-033) proven over every group-C example: each rule is
// applied to every leaf or member it governs, so a schema that loosens one field anywhere in
// the 23 types fails here. Free-form values (support/json-scope.ts) are outside the rules that
// constrain a leaf's shape; meaningful nulls are checked where null carries meaning. The case
// names are the criterion's.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isSha256Hex } from '../../../../src/record-contract/digests.ts';
import { isUuid4 } from '../../../../src/record-contract/identifiers.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import * as groupC from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import { isUtcMillis } from '../../../../src/record-contract/timestamps.ts';
import { assertAccepted, assertRejected } from '../group-b/support/group-b-validation.ts';
import { leavesOf, objectPathsOf, pointerOf, textOf, withMember, withValueAt } from '../group-b/support/json-paths.ts';
import type { JsonLeaf, JsonPath } from '../group-b/support/json-paths.ts';
import { toJson } from '../group-b/support/record-builders.ts';
import { GROUP_C_EXAMPLES } from './examples/group-c-examples.ts';
import { NULLABLE_FREE_FORM_MEMBERS, NULLABLE_MEMBERS, isFreeForm, isNullable, isProse } from './support/json-scope.ts';
import type { GroupCExample } from './support/record-example.ts';

type LeafMutation = (value: JsonValue) => JsonValue;

interface ExampleJson {
  readonly example: GroupCExample;
  readonly json: JsonObject;
}

const EXAMPLES: readonly ExampleJson[] = GROUP_C_EXAMPLES.map((example) => ({ example, json: toJson(example.record) }));

/**
 * Applies each mutation to every leaf `governs` selects (outside free-form values) in every
 * example, asserts each mutated record is rejected at that leaf, and returns how many leaves
 * were governed so a rule can never pass vacuously.
 */
function rejectEveryGovernedLeaf(
  governs: (value: JsonValue, leaf: JsonLeaf) => boolean,
  mutations: readonly LeafMutation[],
): number {
  let governed = 0;
  for (const { example, json } of EXAMPLES) {
    const leaves = leavesOf(json).filter((leaf) => !isFreeForm(leaf.path) && governs(leaf.value, leaf));
    governed += leaves.length;
    for (const [leaf, mutate] of leaves.flatMap((leaf) => mutations.map((mutate) => [leaf, mutate] as const))) {
      const mutated = mutate(leaf.value);
      const label = `${example.label}${pointerOf(leaf.path)} = ${JSON.stringify(mutated)}`;
      assertRejected(withValueAt(json, leaf.path, mutated), label, pointerOf(leaf.path));
    }
  }
  return governed;
}

const UPPER_SNAKE_VALUE = /^[A-Z][A-Z0-9_]*[A-Z]$/;

// Every lowercase value of a group-C closed vocabulary (verdicts, validities, statuses).
const VOCABULARY_VALUES: readonly (string | number)[] = Object.values(groupC).flat();
const LOWERCASE_VOCABULARY: ReadonlySet<string> = new Set(
  VOCABULARY_VALUES.filter((value): value is string => typeof value === 'string' && /^[a-z][a-z_]*$/.test(value)),
);

function memberOf(leaf: JsonLeaf): string {
  return String(leaf.path.at(-1) ?? '');
}

/** Omitting a member is valid exactly when the example declares it optional. */
function assertOmission(example: GroupCExample, json: JsonObject, key: string): void {
  const label = `${example.label} without ${key}`;
  if (example.optional.includes(key)) {
    assertAccepted(withMember(json, key, undefined), label);
    return;
  }
  assertRejected(withMember(json, key, undefined), label);
}

/** The outermost path of each free-form value: a JSON value whose own kind is still governed. */
function freeFormRootsOf(json: JsonObject): readonly JsonPath[] {
  const roots = new Map<string, JsonPath>();
  for (const leaf of leavesOf(json).filter((candidate) => isFreeForm(candidate.path))) {
    const length = leaf.path.findIndex((_segment, index) => isFreeForm(leaf.path.slice(0, index + 1)));
    const root = leaf.path.slice(0, length + 1);
    roots.set(pointerOf(root), root);
  }
  return [...roots.values()];
}

/** A free-form value is any non-null JSON, except where null is a projected value itself. */
function assertNullFreeFormValue(example: GroupCExample, json: JsonObject, path: JsonPath): void {
  const nulled = withValueAt(json, path, null);
  const label = `${example.label}${pointerOf(path)}: null free-form value`;
  if (NULLABLE_FREE_FORM_MEMBERS.includes(String(path.at(-1)))) {
    assertAccepted(nulled, label);
    return;
  }
  assertRejected(nulled, label, pointerOf(path));
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

describe('AC-RUA-046 serialization rules over group C', () => {
  it('every example is valid after kernel serialization', () => {
    assert.equal(EXAMPLES.length, 54);
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
      for (const path of objectPathsOf(json).filter((objectPath) => !isFreeForm(objectPath))) {
        assertRejected(withValueAt(json, [...path, 'extraField'], 1), `${example.label}${pointerOf(path)}/extraField`);
      }
      assertRejected(withMember(json, 'record_type', textOf(json['record_type'] ?? null).toUpperCase()), example.label);
    }
    const upperSnake = (value: JsonValue): boolean => typeof value === 'string' && UPPER_SNAKE_VALUE.test(value);
    assert.equal(rejectEveryGovernedLeaf(upperSnake, [(value): JsonValue => textOf(value).toLowerCase()]), 156);
    const lowercase = (value: JsonValue, leaf: JsonLeaf): boolean =>
      typeof value === 'string' && LOWERCASE_VOCABULARY.has(value) && !isProse(leaf.path);
    assert.equal(rejectEveryGovernedLeaf(lowercase, [(value): JsonValue => textOf(value).toUpperCase()]), 531);
  });

  it('millisecond UTC', () => {
    const mutations: readonly LeafMutation[] = [
      (value): JsonValue => textOf(value).replace(/\.\d{3}Z$/, 'Z'),
      (value): JsonValue => textOf(value).replace(/Z$/, '000Z'),
      (value): JsonValue => textOf(value).replace(/Z$/, '+00:00'),
      (value): JsonValue => textOf(value).replace(/Z$/, 'z'),
      (value): JsonValue => textOf(value).replace(/^\d{4}-\d{2}-\d{2}/, '2026-02-30'),
    ];
    assert.equal(rejectEveryGovernedLeaf(isUtcMillis, mutations), 95);
  });

  it('lowercase UUIDv4', () => {
    const mutations: readonly LeafMutation[] = [
      (value): JsonValue => textOf(value).toUpperCase().replace(/^0/, 'A'),
      (value): JsonValue => textOf(value).replaceAll('-', ''),
      (value): JsonValue => `${textOf(value).slice(0, 14)}1${textOf(value).slice(15)}`,
      (value): JsonValue => `{${textOf(value)}}`,
    ];
    assert.equal(rejectEveryGovernedLeaf(isUuid4, mutations), 125);
  });

  it('lowercase SHA-256 digests', () => {
    const mutations = [
      (value: JsonValue): JsonValue => textOf(value).toUpperCase(),
      (value: JsonValue): JsonValue => textOf(value).slice(1),
    ];
    assert.equal(rejectEveryGovernedLeaf(isSha256Hex, mutations), 354);
  });

  it('safe-integer amounts', () => {
    const mutations: readonly LeafMutation[] = [
      (value): JsonValue => Number(value) + 0.5,
      (value): JsonValue => textOf(value),
      (): JsonValue => -1,
      (): JsonValue => Number.MAX_SAFE_INTEGER + 1,
    ];
    const isNumber = (value: JsonValue): boolean => typeof value === 'number';
    assert.equal(rejectEveryGovernedLeaf(isNumber, mutations), 134);
  });

  it('decimal aggregates', () => {
    const aggregate = (_value: JsonValue, leaf: JsonLeaf): boolean =>
      memberOf(leaf) === 'refunded_total_minor' || memberOf(leaf).endsWith('_ns');
    const aggregateMutations: readonly LeafMutation[] = [
      (value): JsonValue => `0${textOf(value)}`,
      (): JsonValue => '-1',
      (): JsonValue => '1.5',
      (): JsonValue => '1e3',
      (value): JsonValue => Number(value),
    ];
    assert.equal(rejectEveryGovernedLeaf(aggregate, aggregateMutations), 7);
    const money = (_value: JsonValue, leaf: JsonLeaf): boolean =>
      ['cost', 'ceiling_usd', 'attributed_total_usd'].includes(memberOf(leaf));
    const moneyMutations: readonly LeafMutation[] = [
      (value): JsonValue => `0${textOf(value)}`,
      (value): JsonValue => `-${textOf(value)}`,
      (): JsonValue => '1e3',
      (): JsonValue => '.5',
      (): JsonValue => '1.',
      (value): JsonValue => Number(value),
    ];
    assert.equal(rejectEveryGovernedLeaf(money, moneyMutations), 6);
  });

  it('booleans are JSON booleans', () => {
    const mutations = [
      (value: JsonValue): JsonValue => textOf(value),
      (value: JsonValue): JsonValue => (value === true ? 1 : 0),
    ];
    const isBoolean = (value: JsonValue): boolean => typeof value === 'boolean';
    assert.equal(rejectEveryGovernedLeaf(isBoolean, mutations), 71);
  });

  it('omitted versus null', () => {
    for (const { example, json } of EXAMPLES) {
      for (const member of example.optional) {
        assert.ok(member in json, `${example.label} declares ${member}, which the example must carry`);
      }
      for (const key of Object.keys(json)) {
        assertOmission(example, json, key);
      }
      for (const key of Object.keys(json).filter((name) => !NULLABLE_MEMBERS.includes(name))) {
        assertRejected(withMember(json, key, null), `${example.label} ${key}: null`, `/${key}`);
      }
      const leaves = leavesOf(json).filter((leaf) => !isFreeForm(leaf.path) && !isNullable(leaf.path));
      for (const leaf of leaves) {
        assertRejected(withValueAt(json, leaf.path, null), `${example.label}${pointerOf(leaf.path)}: null`);
      }
    }
  });

  it('null only with meaning', () => {
    const nullLeaves = EXAMPLES.flatMap(({ example, json }) =>
      leavesOf(json)
        .filter((leaf) => leaf.value === null && !isFreeForm(leaf.path))
        .map((leaf) => ({ label: example.label, leaf })),
    );
    for (const { label, leaf } of nullLeaves) {
      assert.ok(isNullable(leaf.path), `${label}${pointerOf(leaf.path)} is null without meaning`);
    }
    assert.equal(nullLeaves.length, 9);
    const roots = EXAMPLES.flatMap(({ example, json }) =>
      freeFormRootsOf(json).map((path) => ({ example, json, path })),
    );
    for (const { example, json, path } of roots) {
      assertNullFreeFormValue(example, json, path);
    }
    assert.equal(roots.length, 201);
  });

  it('schema_version and record_type present', () => {
    for (const { example, json } of EXAMPLES) {
      assertRejected(withMember(json, 'schema_version', undefined), example.label, ' required');
      assertRejected(withMember(json, 'record_type', undefined), example.label, '/record_type record_type');
      for (const version of [0, 2, '1', 1.5]) {
        assertRejected(withMember(json, 'schema_version', version), `${example.label} v${String(version)}`);
      }
      const other = json['record_type'] === 'cli_result' ? 'run_summary' : 'cli_result';
      assertRejected(withMember(json, 'record_type', other), `${example.label} as ${other}`);
    }
  });
});
