// Catalogue conventions every record schema must follow (design §6, §6.1). The registry
// refuses a schema that breaks one, so a catalogue package cannot drift from BR-RUA-033.

import { isJsonArray, isJsonObject as isObject } from './json-value.ts';
import type { JsonObject, JsonValue } from './primitives.ts';
import { isEventRecordType } from './record-types.ts';
import type { RecordType } from './record-types.ts';

export const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
export const SCHEMA_ID_BASE = 'https://rua.serverless-under-constraints.invalid/schemas/';
export const DEFS_SCHEMA_ID = `${SCHEMA_ID_BASE}_defs.schema.json`;
export const EVENT_ENVELOPE_REF = '_defs.schema.json#/$defs/event_envelope';

const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const FORBIDDEN_CLOSURE_KEYWORD = 'unevaluatedProperties';

/**
 * The `$id` a record schema must declare, so `_defs.schema.json#/...` resolves relatively.
 *
 * @example
 * recordSchemaId('payment'); // 'https://rua.serverless-under-constraints.invalid/schemas/payment.schema.json'
 */
export function recordSchemaId(recordType: RecordType): string {
  return `${SCHEMA_ID_BASE}${recordType}.schema.json`;
}

/**
 * Lists every convention a record schema breaks; an empty list means it conforms.
 *
 * @example
 * findSchemaConventionViolations('payment', schema); // [] or ['property "paymentId" at /properties ...']
 */
export function findSchemaConventionViolations(recordType: RecordType, schema: JsonValue): readonly string[] {
  if (!isObject(schema)) {
    return [`schema is ${JSON.stringify(schema)}; expected a JSON Schema object`];
  }
  return [
    ...headerViolations(recordType, schema),
    ...closureViolations(schema),
    ...findUnevaluatedPropertiesViolations(schema),
    ...envelopeViolations(recordType, schema),
    ...findNonSnakeCaseProperties(schema, ''),
  ];
}

/**
 * Walks a schema and reports every declared property name that is not `snake_case`.
 *
 * @example
 * findNonSnakeCaseProperties({ properties: { recordType: {} } }, ''); // ['property "recordType" at /properties ...']
 */
export function findNonSnakeCaseProperties(node: JsonValue, pointer: string): readonly string[] {
  if (isJsonArray(node)) {
    return node.flatMap((child, index) => findNonSnakeCaseProperties(child, `${pointer}/${String(index)}`));
  }
  if (!isObject(node)) {
    return [];
  }
  const declared = node['properties'];
  const own = isObject(declared)
    ? Object.keys(declared)
        .filter((name) => !PROPERTY_NAME_PATTERN.test(name))
        .map(
          (name) => `property ${JSON.stringify(name)} at ${pointer}/properties is not snake_case (^[a-z][a-z0-9_]*$)`,
        )
    : [];
  const nested = Object.entries(node).flatMap(([key, child]) => findNonSnakeCaseProperties(child, `${pointer}/${key}`));
  return [...own, ...nested];
}

function headerViolations(recordType: RecordType, schema: JsonObject): readonly string[] {
  const violations: string[] = [];
  expectValue(violations, '$schema', schema['$schema'], SCHEMA_DIALECT);
  expectValue(violations, '$id', schema['$id'], recordSchemaId(recordType));
  expectValue(violations, 'type', schema['type'], 'object');
  const properties = isObject(schema['properties']) ? schema['properties'] : {};
  const version = properties['schema_version'];
  const type = properties['record_type'];
  expectValue(violations, 'properties.schema_version.const', isObject(version) ? version['const'] : undefined, 1);
  expectValue(violations, 'properties.record_type.const', isObject(type) ? type['const'] : undefined, recordType);
  const required = isJsonArray(schema['required']) ? schema['required'] : [];
  for (const field of ['schema_version', 'record_type']) {
    if (!required.includes(field)) {
      violations.push(`required does not list ${JSON.stringify(field)}; expected both schema_version and record_type`);
    }
  }
  return violations;
}

/**
 * Reports every `unevaluatedProperties` keyword in a schema, at any depth, by JSON pointer. Ajv
 * tracks evaluated names in a plain object, so an inherited name such as `__proto__` or
 * `toString` counts as evaluated and passes `unevaluatedProperties: false`; record schemas close
 * every object with `additionalProperties: false` instead (design §6, Owner amendment A-07).
 * The walk is iterative, so a deep schema cannot exhaust the stack.
 *
 * @example
 * findUnevaluatedPropertiesViolations({ allOf: [{ unevaluatedProperties: false }] });
 * // ['unevaluatedProperties at /allOf/0; expected additionalProperties: false (A-07: ...)']
 */
export function findUnevaluatedPropertiesViolations(schema: JsonValue): readonly string[] {
  const violations: string[] = [];
  const pending: [JsonValue, string][] = [[schema, '']];
  // for-of over an array visits the entries pushed during the walk, so this is a breadth-first queue.
  for (const [node, pointer] of pending) {
    const children = childEntriesOf(node);
    // Array keys are indices, so only an object member can carry the keyword name.
    if (children.some(([key]) => key === FORBIDDEN_CLOSURE_KEYWORD)) {
      violations.push(
        `${FORBIDDEN_CLOSURE_KEYWORD} at ${pointer === '' ? 'the root' : pointer}; expected additionalProperties: false (A-07: Ajv counts inherited names such as __proto__ as evaluated)`,
      );
    }
    for (const [key, child] of children) {
      pending.push([child, `${pointer}/${key}`]);
    }
  }
  return violations;
}

function childEntriesOf(node: JsonValue): readonly (readonly [string, JsonValue])[] {
  if (isJsonArray(node)) {
    return node.map((child, index) => [String(index), child] as const);
  }
  return isObject(node) ? Object.entries(node) : [];
}

function closureViolations(schema: JsonObject): readonly string[] {
  if (schema['additionalProperties'] === false) {
    return [];
  }
  return ['schema is open; expected additionalProperties: false at the root'];
}

function envelopeViolations(recordType: RecordType, schema: JsonObject): readonly string[] {
  if (!isEventRecordType(recordType)) {
    return [];
  }
  const allOf = isJsonArray(schema['allOf']) ? schema['allOf'] : [];
  const composesEnvelope = allOf.some((entry) => isObject(entry) && entry['$ref'] === EVENT_ENVELOPE_REF);
  return composesEnvelope
    ? []
    : [`event schema does not compose the envelope; expected allOf to contain {"$ref": "${EVENT_ENVELOPE_REF}"}`];
}

function expectValue(violations: string[], field: string, actual: JsonValue | undefined, expected: JsonValue): void {
  if (actual !== expected) {
    violations.push(
      `${field} is ${actual === undefined ? 'absent' : JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
    );
  }
}
