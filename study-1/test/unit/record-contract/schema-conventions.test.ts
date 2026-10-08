// Catalogue conventions a record schema must follow (design §6, §6.1).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import {
  DEFS_SCHEMA_ID,
  EVENT_ENVELOPE_REF,
  SCHEMA_DIALECT,
  SCHEMA_ID_BASE,
  findNonSnakeCaseProperties,
  findSchemaConventionViolations,
  findUnevaluatedPropertiesViolations,
  recordSchemaId,
} from '../../../src/record-contract/schema-conventions.ts';

const UNEVALUATED_EXPECTATION =
  'expected additionalProperties: false (A-07: Ajv counts inherited names such as __proto__ as evaluated)';

function conformingSchema(recordType: string, extra: JsonObject = {}): JsonObject {
  return {
    $schema: SCHEMA_DIALECT,
    $id: `${SCHEMA_ID_BASE}${recordType}.schema.json`,
    type: 'object',
    properties: { schema_version: { const: 1 }, record_type: { const: recordType } },
    required: ['schema_version', 'record_type'],
    additionalProperties: false,
    ...extra,
  };
}

describe('schema identifiers', () => {
  it('derives ids from the .invalid base so relative $defs references resolve', () => {
    assert.equal(SCHEMA_DIALECT, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(
      recordSchemaId('payment'),
      'https://rua.serverless-under-constraints.invalid/schemas/payment.schema.json',
    );
    assert.equal(DEFS_SCHEMA_ID, 'https://rua.serverless-under-constraints.invalid/schemas/_defs.schema.json');
    assert.equal(EVENT_ENVELOPE_REF, '_defs.schema.json#/$defs/event_envelope');
  });
});

describe('findSchemaConventionViolations', () => {
  it('accepts a conforming record schema', () => {
    assert.deepEqual(findSchemaConventionViolations('payment', conformingSchema('payment')), []);
  });

  it('refuses a schema closed with unevaluatedProperties instead of additionalProperties (A-07)', () => {
    const schema = conformingSchema('dispatch_started', {
      allOf: [{ $ref: EVENT_ENVELOPE_REF }],
      unevaluatedProperties: false,
    });
    const { additionalProperties: _ignored, ...withoutAdditional } = schema;
    assert.deepEqual(findSchemaConventionViolations('dispatch_started', withoutAdditional), [
      'schema is open; expected additionalProperties: false at the root',
      `unevaluatedProperties at the root; ${UNEVALUATED_EXPECTATION}`,
    ]);
    assert.deepEqual(findSchemaConventionViolations('dispatch_started', schema), [
      `unevaluatedProperties at the root; ${UNEVALUATED_EXPECTATION}`,
    ]);
  });

  it('refuses a schema that is not an object', () => {
    assert.deepEqual(findSchemaConventionViolations('payment', [1]), ['schema is [1]; expected a JSON Schema object']);
  });

  it('reports every header deviation with the value found and the value expected', () => {
    const violations = findSchemaConventionViolations('payment', {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'array',
      properties: { schema_version: { const: 2 }, record_type: true },
      required: ['record_type'],
      additionalProperties: false,
    });
    assert.deepEqual(violations, [
      '$schema is "http://json-schema.org/draft-07/schema#"; expected "https://json-schema.org/draft/2020-12/schema"',
      '$id is absent; expected "https://rua.serverless-under-constraints.invalid/schemas/payment.schema.json"',
      'type is "array"; expected "object"',
      'properties.schema_version.const is 2; expected 1',
      'properties.record_type.const is absent; expected "payment"',
      'required does not list "schema_version"; expected both schema_version and record_type',
    ]);
  });

  it('reports missing properties and required lists', () => {
    const { properties: _p, required: _r, ...bare } = conformingSchema('payment');
    assert.deepEqual(findSchemaConventionViolations('payment', bare), [
      'properties.schema_version.const is absent; expected 1',
      'properties.record_type.const is absent; expected "payment"',
      'required does not list "schema_version"; expected both schema_version and record_type',
      'required does not list "record_type"; expected both schema_version and record_type',
    ]);
    const versionOnly = conformingSchema('payment', {
      properties: { schema_version: true, record_type: { const: 'payment' } },
    });
    assert.deepEqual(findSchemaConventionViolations('payment', versionOnly), [
      'properties.schema_version.const is absent; expected 1',
    ]);
  });

  it('refuses an open root', () => {
    const open = conformingSchema('payment', { additionalProperties: true });
    assert.deepEqual(findSchemaConventionViolations('payment', open), [
      'schema is open; expected additionalProperties: false at the root',
    ]);
    const { additionalProperties: _a, ...absent } = conformingSchema('payment');
    assert.equal(findSchemaConventionViolations('payment', absent).length, 1);
  });

  it('requires event schemas to compose the envelope', () => {
    const expected = [
      `event schema does not compose the envelope; expected allOf to contain {"$ref": "${EVENT_ENVELOPE_REF}"}`,
    ];
    assert.deepEqual(
      findSchemaConventionViolations('dispatch_started', conformingSchema('dispatch_started')),
      expected,
    );
    const wrongRef = conformingSchema('dispatch_started', { allOf: ['x', { $ref: '_defs.schema.json#/$defs/uuid4' }] });
    assert.deepEqual(findSchemaConventionViolations('dispatch_started', wrongRef), expected);
    const notArray = conformingSchema('dispatch_started', { allOf: { $ref: EVENT_ENVELOPE_REF } });
    assert.deepEqual(findSchemaConventionViolations('dispatch_started', notArray), expected);
    const composed = conformingSchema('dispatch_started', { allOf: [{ $ref: 'other' }, { $ref: EVENT_ENVELOPE_REF }] });
    assert.deepEqual(findSchemaConventionViolations('dispatch_started', composed), []);
  });

  it('includes non-snake_case property names', () => {
    const schema = conformingSchema('payment', {
      properties: { schema_version: { const: 1 }, record_type: { const: 'payment' }, paymentId: { type: 'string' } },
    });
    assert.deepEqual(findSchemaConventionViolations('payment', schema), [
      'property "paymentId" at /properties is not snake_case (^[a-z][a-z0-9_]*$)',
    ]);
  });
});

describe('findNonSnakeCaseProperties', () => {
  it('walks nested schemas, arrays and $defs with JSON pointers', () => {
    const schema: JsonObject = {
      properties: { ok_name: { properties: { Bad: {} } }, _lead: {}, '9lives': {}, 'kebab-case': {}, a1_b: {} },
      allOf: [{ properties: { camelCase: {} } }],
      $defs: { thing: { properties: { fine: {}, UPPER: {} } } },
    };
    assert.deepEqual(findNonSnakeCaseProperties(schema, ''), [
      'property "_lead" at /properties is not snake_case (^[a-z][a-z0-9_]*$)',
      'property "9lives" at /properties is not snake_case (^[a-z][a-z0-9_]*$)',
      'property "kebab-case" at /properties is not snake_case (^[a-z][a-z0-9_]*$)',
      'property "Bad" at /properties/ok_name/properties is not snake_case (^[a-z][a-z0-9_]*$)',
      'property "camelCase" at /allOf/0/properties is not snake_case (^[a-z][a-z0-9_]*$)',
      'property "UPPER" at /$defs/thing/properties is not snake_case (^[a-z][a-z0-9_]*$)',
    ]);
  });

  it('ignores a non-object properties value and scalars', () => {
    assert.deepEqual(findNonSnakeCaseProperties({ properties: ['NotAName'] }, '/x'), []);
    assert.deepEqual(findNonSnakeCaseProperties('Bad', ''), []);
  });
});

describe('findUnevaluatedPropertiesViolations', () => {
  it('reports the keyword at any depth, through arrays, $defs and compositions', () => {
    const schema: JsonObject = {
      additionalProperties: false,
      properties: { nested: { type: 'object', unevaluatedProperties: false } },
      allOf: [{ if: { unevaluatedProperties: true } }],
      $defs: { shape: { unevaluatedProperties: { type: 'string' } } },
    };
    assert.deepEqual(findUnevaluatedPropertiesViolations(schema), [
      `unevaluatedProperties at /properties/nested; ${UNEVALUATED_EXPECTATION}`,
      `unevaluatedProperties at /$defs/shape; ${UNEVALUATED_EXPECTATION}`,
      `unevaluatedProperties at /allOf/0/if; ${UNEVALUATED_EXPECTATION}`,
    ]);
  });

  it('ignores the word in values, descriptions and scalars', () => {
    const schema: JsonObject = {
      description: 'never unevaluatedProperties',
      enum: ['unevaluatedProperties'],
      additionalProperties: false,
    };
    assert.deepEqual(findUnevaluatedPropertiesViolations(schema), []);
    assert.deepEqual(findUnevaluatedPropertiesViolations('unevaluatedProperties'), []);
    assert.deepEqual(findUnevaluatedPropertiesViolations(null), []);
  });

  it('walks a 100,000-level schema without exhausting the stack', () => {
    let schema: JsonObject = { unevaluatedProperties: false };
    for (let level = 0; level < 100_000; level += 1) {
      schema = { items: schema };
    }
    const found = findUnevaluatedPropertiesViolations(schema);
    assert.equal(found.length, 1);
    assert.match(found[0] ?? '', /^unevaluatedProperties at (\/items){100000}; expected additionalProperties: false/);
  });
});
