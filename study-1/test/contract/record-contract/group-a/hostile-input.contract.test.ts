// Totality of the group A schemas under hostile input (Owner amendments A-02, A-05; design
// §8.2): the record validator rejects every value that JSON.parse or the kernel parser can hand
// it, and never throws. The cases cover deep nesting (100,000 levels, which once threw
// RangeError through the self-recursive preflight check value, WP-01 review round 1),
// non-finite numbers (`1e400` parses to Infinity) and member names inherited from
// Object.prototype. They run through the real registry (Ajv 2020-12 strict) and the real
// group A schemas.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { isJsonArray, isJsonObject } from '../../../../src/record-contract/json-value.ts';
import { parseJsonDocument } from '../../../../src/record-contract/parsing.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import { RECORD_TYPE_GROUPS } from '../../../../src/record-contract/record-types.ts';
import { PREFLIGHT_VALUE_MAX_DEPTH } from '../../../../src/record-contract/records/group-a/preflight_check_recorded.ts';
import { DEFAULT_SCHEMA_ROOT } from '../../../../src/record-contract/schema-registry.ts';
import type { RecordValidation } from '../../../../src/record-contract/schema-registry.ts';
import { pointerOf, withValueAt } from '../group-b/support/json-paths.ts';
import type { JsonPath } from '../group-b/support/json-paths.ts';
import { failedPreflightCheck, sourceProvenance, transportScopeSnapshot } from './support/admission-examples.ts';
import { CANONICAL_EXAMPLES, allValidExamples } from './support/canonical-examples.ts';
import { runExecutionManifest } from './support/manifest-examples.ts';
import { governedObjectSites, numberLeafSites } from './support/mutation-sites.ts';
import { asJson, catalogueValidator } from './support/validation-assertions.ts';

const HOSTILE_DEPTH = 100_000;
const INHERITED_NAMES: readonly string[] = [
  '__proto__',
  'constructor',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__defineGetter__',
];
const EXAMPLES = allValidExamples();

/** Parses JSON text with the kernel parser, as the bytes of an untrusted artifact would be. */
function parsedText(text: string): JsonValue {
  const parsed = parseJsonDocument(new TextEncoder().encode(text));
  assert.ok(parsed.ok, `the kernel parser accepts ${text.slice(0, 40)}...`);
  return parsed.value;
}

/** An array nested `depth` levels around the number 1, e.g. `[[1]]` for depth 2. */
function nestedArray(depth: number): JsonValue {
  return parsedText(`${'['.repeat(depth)}1${']'.repeat(depth)}`);
}

/** An object nested `depth` levels around the number 1, e.g. `{"a":{"a":1}}` for depth 2. */
function nestedObject(depth: number): JsonValue {
  return parsedText(`${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`);
}

const HOSTILE_VALUES: readonly (readonly [string, JsonValue])[] = [
  ['array', nestedArray(HOSTILE_DEPTH)],
  ['object', nestedObject(HOSTILE_DEPTH)],
];

/** Validates without letting a throw escape as anything but a labelled failure. */
function validateTotally(record: JsonValue, label: string): RecordValidation {
  try {
    return catalogueValidator.validate(record);
  } catch (error) {
    assert.fail(`${label}: the validator threw ${String(error)} instead of returning a verdict`);
  }
}

function assertRejectedTotally(record: JsonValue, label: string): void {
  assert.equal(validateTotally(record, label).valid, false, `${label}: expected a rejection`);
}

// Every local `$ref` target inside a schema node (schemas are trusted and shallow).
function localRefsOf(node: JsonValue): readonly string[] {
  if (isJsonArray(node)) {
    return node.flatMap(localRefsOf);
  }
  if (!isJsonObject(node)) {
    return [];
  }
  const own = typeof node['$ref'] === 'string' && node['$ref'].startsWith('#/$defs/') ? [node['$ref'].slice(8)] : [];
  return [...own, ...Object.values(node).flatMap(localRefsOf)];
}

function schemaOf(recordType: string): JsonObject {
  const schema = parsedText(readFileSync(join(DEFAULT_SCHEMA_ROOT, 'group-a', `${recordType}.schema.json`), 'utf8'));
  assert.ok(isJsonObject(schema), `${recordType}: the schema is an object`);
  return schema;
}

function defsOf(schema: JsonObject): JsonObject {
  const defs = schema['$defs'];
  return isJsonObject(defs) ? defs : {};
}

// True when following local `$ref`s from `start` can reach `start` again.
function reachesItself(defs: JsonObject, start: string): boolean {
  const pending = [...localRefsOf(defs[start] ?? null)];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const next = pending.pop() ?? start;
    if (next === start) {
      return true;
    }
    if (!seen.has(next)) {
      seen.add(next);
      pending.push(...localRefsOf(defs[next] ?? null));
    }
  }
  return false;
}

describe('group A records under hostile input (A-02, A-05)', () => {
  it('rejects a 100,000-level preflight expected or observed value without throwing', () => {
    for (const member of ['expected', 'observed']) {
      for (const [shape, hostile] of HOSTILE_VALUES) {
        const record = withValueAt(asJson(failedPreflightCheck()), [member], hostile);
        const result = validateTotally(record, `${member} ${shape}`);
        const paths = result.valid ? [] : result.violations.map((violation) => violation.instance_path);
        assert.ok(paths.length > 0, `${member} ${shape}: expected a rejection`);
        assert.ok(
          paths.every((path) => path.startsWith(`/${member}`)),
          `${member} ${shape}: ${JSON.stringify(paths.slice(0, 3))}`,
        );
      }
    }
  });

  it(`bounds a check value at PREFLIGHT_VALUE_MAX_DEPTH (${String(PREFLIGHT_VALUE_MAX_DEPTH)}) nested levels`, () => {
    assert.equal(PREFLIGHT_VALUE_MAX_DEPTH, 8);
    for (const [shape, nested] of [
      ['array', nestedArray],
      ['object', nestedObject],
    ] as const) {
      const atBound = withValueAt(asJson(failedPreflightCheck()), ['observed'], nested(PREFLIGHT_VALUE_MAX_DEPTH));
      assert.equal(validateTotally(atBound, `${shape} at the bound`).valid, true, `${shape} at the bound`);
      const beyond = withValueAt(asJson(failedPreflightCheck()), ['observed'], nested(PREFLIGHT_VALUE_MAX_DEPTH + 1));
      assertRejectedTotally(beyond, `${shape} one level beyond the bound`);
    }
  });

  it('unrolls the check value to exactly the bound, and no group A schema refers to itself', () => {
    const preflight = schemaOf('preflight_check_recorded');
    const defs = defsOf(preflight);
    // check_value_n refers to the scalars and to check_value_(n-1); check_value_1 to scalars only.
    for (let depth = PREFLIGHT_VALUE_MAX_DEPTH; depth >= 1; depth -= 1) {
      const lower = depth === 1 ? 'check_scalar' : `check_value_${String(depth - 1)}`;
      const refs = new Set(localRefsOf(defs[`check_value_${String(depth)}`] ?? null));
      assert.deepEqual(
        [...refs].toSorted(),
        [...new Set(['check_scalar', lower])].toSorted(),
        `level ${String(depth)}`,
      );
    }
    assert.deepEqual(localRefsOf(defs['check_scalar'] ?? null), [], 'the scalar level nests nothing');
    assert.equal(Object.keys(defs).length, PREFLIGHT_VALUE_MAX_DEPTH + 1);
    for (const recordType of RECORD_TYPE_GROUPS['group-a']) {
      const recordDefs = defsOf(schemaOf(recordType));
      for (const name of Object.keys(recordDefs)) {
        assert.equal(reachesItself(recordDefs, name), false, `${recordType} $defs/${name} is recursive`);
      }
    }
  });

  it('rejects 100,000-level nesting in every open slot and as an unknown member of every record type', () => {
    const openSlots: readonly (readonly [string, JsonObject, JsonPath])[] = [
      ['preflight value member', asJson(failedPreflightCheck()), ['observed', 'approved_amount_minor']],
      ['runtime property', asJson(transportScopeSnapshot()), ['runtime_properties', 'node_runtime']],
      ['declared difference', asJson(runExecutionManifest()), ['declared_variant_differences', 0, 'conventional']],
      ['resource count', asJson(runExecutionManifest()), ['estimates', 'resource_counts', 'functions']],
      ['manifest tool version', asJson(runExecutionManifest()), ['source', 'tool_versions', 'node']],
      ['provenance tool version', asJson(sourceProvenance()), ['tool_versions', 'node']],
    ];
    for (const [slot, record, path] of openSlots) {
      for (const [shape, hostile] of HOSTILE_VALUES) {
        assertRejectedTotally(withValueAt(record, path, hostile), `${slot} ${pointerOf(path)} ${shape}`);
      }
    }
    for (const recordType of RECORD_TYPE_GROUPS['group-a']) {
      for (const [shape, hostile] of HOSTILE_VALUES) {
        const record = withValueAt(CANONICAL_EXAMPLES[recordType](), ['x_deep'], hostile);
        assertRejectedTotally(record, `${recordType} unknown member ${shape}`);
      }
    }
    // Two equal deep items reach the kernel's uniqueItems comparison after the item rule fails.
    for (const [shape, hostile] of HOSTILE_VALUES) {
      const [difference] = runExecutionManifest().declared_variant_differences;
      assert.ok(difference !== undefined, 'the canonical run declares one difference');
      const deepItem = withValueAt(asJson(difference), ['conventional'], hostile);
      const twice = withValueAt(asJson(runExecutionManifest()), ['declared_variant_differences'], [deepItem, deepItem]);
      assertRejectedTotally(twice, `two deep declared differences ${shape}`);
    }
  });

  it('rejects a non-finite number at every number leaf of every valid example', () => {
    const sites = numberLeafSites(EXAMPLES);
    assert.ok(sites.length > 100, `${String(sites.length)} number leaves`);
    // The kernel parser refuses these literals, but JSON.parse (and so the Lambda Node runtime's
    // event decoding) turns them into Infinity and -Infinity, which then reach the validator.
    for (const literal of ['1e400', '-1e400']) {
      assert.equal(parseJsonDocument(new TextEncoder().encode(literal)).ok, false, `kernel parser on ${literal}`);
      const nonFinite = JSON.parse(literal) as JsonValue;
      assert.equal(Number.isFinite(nonFinite), false, `${literal} parses to a non-finite number`);
      for (const site of sites) {
        assertRejectedTotally(
          withValueAt(site.record, site.path, nonFinite),
          `${site.label}${pointerOf(site.path)} = ${literal}`,
        );
      }
    }
  });

  it('rejects every inherited member name on every governed object', () => {
    const sites = governedObjectSites(EXAMPLES);
    for (const site of sites) {
      for (const name of INHERITED_NAMES) {
        const mutated = withValueAt(site.record, [...site.path, name], 1);
        assertRejectedTotally(mutated, `${site.label}${pointerOf(site.path)} with own member ${name}`);
      }
    }
  });

  it('accepts only the snake_case name constructor, as data, in an open map', () => {
    const openMaps: readonly (readonly [string, JsonObject, JsonPath, JsonValue])[] = [
      ['resource counts', asJson(runExecutionManifest()), ['estimates', 'resource_counts'], 1],
      ['manifest tool versions', asJson(runExecutionManifest()), ['source', 'tool_versions'], 'v1'],
      ['provenance tool versions', asJson(sourceProvenance()), ['tool_versions'], 'v1'],
      ['runtime properties', asJson(transportScopeSnapshot()), ['runtime_properties'], 'x'],
      ['preflight observed value', asJson(failedPreflightCheck()), ['observed'], 1],
    ];
    for (const [map, record, path, value] of openMaps) {
      for (const name of INHERITED_NAMES) {
        const result = validateTotally(withValueAt(record, [...path, name], value), `${map} ${name}`);
        // Member names of an open map are data; consumers read them as own properties (A-05).
        assert.equal(result.valid, name === 'constructor', `${map} with own member ${name}`);
      }
    }
  });
});
