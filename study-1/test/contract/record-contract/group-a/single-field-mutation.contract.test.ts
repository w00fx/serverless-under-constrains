// AC-RUA-046 (group A) property of design §12.5, "record validators (each group): a valid
// generated record mutated in one field is rejected". The valid records are the canonical
// examples and their conditional branches; each property mutates exactly one top-level field
// and requires the catalogue validator to reject the result. FC_RUNS and FC_SEED set the budget
// and the replay seed (npm run test:fuzz, tools/fuzz-campaign.ts).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import { DEFAULT_SCHEMA_ROOT, listSchemaFiles } from '../../../../src/record-contract/schema-registry.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import { allValidExamples } from './support/canonical-examples.ts';
import type { NamedExample } from './support/canonical-examples.ts';
import { catalogueValidator, withField, withoutField } from './support/validation-assertions.ts';

/** The top-level shape a schema declares: its always-required fields and its declared properties. */
interface TopLevelShape {
  readonly required: readonly string[];
  readonly properties: readonly string[];
}

type JsonTypeName = 'null' | 'boolean' | 'integer' | 'number' | 'string' | 'array' | 'object';

// Fields whose schema admits every non-null JSON value: a different JSON type is still valid
// there (preflight_check_recorded `expected` and `observed`, BR-RUA-039), so they are left out
// of the type-replacement property.
const FREE_FORM_FIELDS: ReadonlySet<string> = new Set(['expected', 'observed']);

function readTopLevelShapes(): ReadonlyMap<string, TopLevelShape> {
  const shapes = new Map<string, TopLevelShape>();
  for (const file of listSchemaFiles().filter((entry) => entry.relative_path.startsWith('group-a/'))) {
    const schema = JSON.parse(readFileSync(join(DEFAULT_SCHEMA_ROOT, file.relative_path), 'utf8')) as {
      readonly required: readonly string[];
      readonly properties: Readonly<Record<string, unknown>>;
    };
    shapes.set(file.record_type, { required: schema.required, properties: Object.keys(schema.properties) });
  }
  return shapes;
}

const SHAPES = readTopLevelShapes();
const EXAMPLES = allValidExamples();

function shapeOf(example: NamedExample): TopLevelShape {
  const recordType = example.record['record_type'];
  const shape = typeof recordType === 'string' ? SHAPES.get(recordType) : undefined;
  if (shape === undefined) {
    throw new Error(
      `example ${JSON.stringify(example.name)} has no group A schema; expected one of ${[...SHAPES.keys()].join(', ')}`,
    );
  }
  return shape;
}

function jsonTypeOf(value: JsonValue | undefined): JsonTypeName {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value as 'boolean' | 'string' | 'object';
}

const VALUES_BY_TYPE: Readonly<Record<Exclude<JsonTypeName, 'number'>, fc.Arbitrary<JsonValue>>> = {
  null: fc.constant(null),
  boolean: fc.boolean(),
  integer: fc.integer(),
  string: fc.string({ maxLength: 12 }),
  array: fc.array(fc.integer(), { maxLength: 2 }),
  object: fc.dictionary(fc.stringMatching(/^[a-z]{1,4}$/), fc.integer(), { maxKeys: 2, noNullPrototype: true }),
};

/** A JSON value whose JSON type differs from the given value's, e.g. a string for an integer. */
function valueOfAnotherType(current: JsonValue | undefined): fc.Arbitrary<JsonValue> {
  const currentType = jsonTypeOf(current);
  const others = Object.entries(VALUES_BY_TYPE)
    .filter(([type]) => type !== currentType)
    .map(([, values]) => values);
  return fc.oneof(...others);
}

const example = fc.constantFrom(...EXAMPLES);
const UNKNOWN_FIELD_NAME = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);

// The failure message is built only on failure: serializing every generated record would
// dominate the property's run time.
function assertInvalid(record: JsonObject, describeMutation: () => string): void {
  if (catalogueValidator.validate(record).valid) {
    assert.fail(`${describeMutation()} was accepted: ${JSON.stringify(record)}`);
  }
}

describe('record validators (group A)', () => {
  it('a valid generated record mutated in one field is rejected', () => {
    const removal = example.chain((chosen) =>
      fc.constantFrom(...shapeOf(chosen).required).map((field) => ({ chosen, field })),
    );
    fc.assert(
      fc.property(removal, ({ chosen, field }) => {
        assertInvalid(withoutField(chosen.record, field), () => `${chosen.name} without ${field}`);
      }),
      fuzzParameters(),
    );

    const replacement = example.chain((chosen) => {
      const fields = Object.keys(chosen.record).filter((field) => !FREE_FORM_FIELDS.has(field));
      return fc
        .constantFrom(...fields)
        .chain((field) => valueOfAnotherType(chosen.record[field]).map((value) => ({ chosen, field, value })));
    });
    fc.assert(
      fc.property(replacement, ({ chosen, field, value }) => {
        assertInvalid(
          withField(chosen.record, field, value),
          () => `${chosen.name} with ${field}=${JSON.stringify(value)}`,
        );
      }),
      fuzzParameters(),
    );

    // The name arbitrary is built once: rebuilding a regex arbitrary inside `chain` for every
    // run made this property take 6.6 s instead of 0.2 s at 1000 runs.
    const addition = fc
      .tuple(example, UNKNOWN_FIELD_NAME)
      .filter(([chosen, field]) => !shapeOf(chosen).properties.includes(field))
      .map(([chosen, field]) => ({ chosen, field }));
    fc.assert(
      fc.property(addition, fc.jsonValue(), ({ chosen, field }, value) => {
        assertInvalid(withField(chosen.record, field, value), () => `${chosen.name} with unknown ${field}`);
      }),
      fuzzParameters(),
    );
  });

  it('starts every property from records the validator accepts', () => {
    assert.equal(EXAMPLES.length, 25);
    for (const valid of EXAMPLES) {
      assert.equal(catalogueValidator.validate(valid.record).valid, true, valid.name);
      assert.ok(shapeOf(valid).required.length >= 2, valid.name);
    }
    assert.equal(SHAPES.size, 18);
    assert.throws(() => shapeOf({ name: 'stray', record: { record_type: 'refund_effect' } }), /no group A schema/);
  });
});
