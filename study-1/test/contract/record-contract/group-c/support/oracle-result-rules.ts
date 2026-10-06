// The generator of the repeated cross-field rules of `oracle_result.schema.json` (WP-03 review
// round 2, maintainability finding). JSON Schema cannot compare two members, so "the top-level
// integrity field equals its gate" and "the mirror rule follows its gate" are one if/then block per
// value: 26 near-identical blocks that hand edits would let drift. This module states each family
// once; `oracle-result-derivations.contract.test.ts` fails when the schema's blocks differ from
// it, and
//
//   node test/contract/record-contract/group-c/support/oracle-result-rules.ts --write
//
// rewrites them in the schema (then `npx prettier --write` the file).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isJsonArray, isJsonObject } from '../../../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../../../src/record-contract/primitives.ts';
import { groupCSchemaPath } from './schema-reading.ts';

/** `oracle_result.schema.json`, the file the generated blocks live in. */
const ORACLE_RESULT_SCHEMA_PATH = groupCSchemaPath('oracle_result');

/** The index of the first generated block in the schema's root `allOf`. */
export const GENERATED_RULES_START = 12;

const GATE_COUNT = 9;
const RULE_COUNT = 10;
const APPLICABLE = ['verified', 'invalid', 'unverified'] as const;
const WITH_NOT_APPLICABLE = [...APPLICABLE, 'not_applicable'] as const;

/** Design §8.5 mirror rules: verified → pass, invalid → fail, unverified → indeterminate. */
const MIRRORED: Readonly<Record<(typeof APPLICABLE)[number], string>> = {
  verified: 'pass',
  invalid: 'fail',
  unverified: 'indeterminate',
};

/**
 * Each top-level integrity field and its gate position (design §8.3: G3, G4a, G4b), with the
 * values that field takes (INV-RUA-001: identity integrity is never `not_applicable`).
 */
const INTEGRITY_FIELDS: readonly (readonly [string, number, readonly string[]])[] = [
  ['identity_integrity', 2, APPLICABLE],
  ['control_integrity', 3, WITH_NOT_APPLICABLE],
  ['treatment_fidelity', 4, WITH_NOT_APPLICABLE],
];

/**
 * Each mirrored gate position and the rule position that mirrors it (design §8.5): G1 →
 * BR-RUA-005, G2 → BR-RUA-008, G3 → INV-RUA-001, G4a and G4b → BR-RUA-025.
 */
const MIRROR_RULES: readonly (readonly [number, number])[] = [
  [0, 4],
  [1, 6],
  [2, 8],
  [3, 9],
  [4, 9],
];

/** A fixed-length tuple schema whose only constrained position is `position`. */
function tupleWith(length: number, position: number, item: JsonObject): JsonObject {
  return {
    prefixItems: Array.from({ length }, (_unused, index): JsonObject => (index === position ? item : {})),
    minItems: length,
    maxItems: length,
    items: false,
    type: 'array',
  };
}

function memberConst(member: string, value: string): JsonObject {
  return { properties: { [member]: { const: value } }, required: [member], type: 'object' };
}

function integrityBlock(field: string, gate: number, value: string): JsonObject {
  return {
    if: { properties: { [field]: { const: value } }, required: [field] },
    then: { properties: { validity_gates: tupleWith(GATE_COUNT, gate, memberConst('value', value)) } },
  };
}

function mirrorBlock(gate: number, rule: number, value: (typeof APPLICABLE)[number]): JsonObject {
  return {
    if: {
      properties: { validity_gates: tupleWith(GATE_COUNT, gate, memberConst('value', value)) },
      required: ['validity_gates'],
    },
    then: { properties: { rule_results: tupleWith(RULE_COUNT, rule, memberConst('result', MIRRORED[value])) } },
  };
}

/**
 * The generated blocks, in schema order: each integrity field equals its gate, then each mirror
 * rule follows its gate.
 *
 * @example
 * generatedOracleRules().length; // 26
 */
export function generatedOracleRules(): readonly JsonObject[] {
  return [
    ...INTEGRITY_FIELDS.flatMap(([field, gate, values]) => values.map((value) => integrityBlock(field, gate, value))),
    ...MIRROR_RULES.flatMap(([gate, rule]) => APPLICABLE.map((value) => mirrorBlock(gate, rule, value))),
  ];
}

/**
 * The schema's root `allOf` with the generated range replaced by `generatedOracleRules()`.
 *
 * @example
 * withGeneratedRules(groupCSchemaOf('oracle_result'));
 */
export function withGeneratedRules(schema: JsonValue): JsonObject {
  if (!isJsonObject(schema) || !isJsonArray(schema['allOf'])) {
    throw new TypeError(
      `oracle_result schema root is ${isJsonObject(schema) ? 'an object without an allOf array' : typeof schema}; expected an object with a root allOf array`,
    );
  }
  const allOf = schema['allOf'];
  const generated = generatedOracleRules();
  return {
    ...schema,
    allOf: [
      ...allOf.slice(0, GENERATED_RULES_START),
      ...generated,
      ...allOf.slice(GENERATED_RULES_START + generated.length),
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  const current: JsonValue = JSON.parse(readFileSync(ORACLE_RESULT_SCHEMA_PATH, 'utf8')) as JsonValue;
  writeFileSync(ORACLE_RESULT_SCHEMA_PATH, `${JSON.stringify(withGeneratedRules(current), null, 2)}\n`);
}
