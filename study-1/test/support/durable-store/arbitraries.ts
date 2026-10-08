// fast-check generators for the durable-store property tests (testing rule 6): storable JSON,
// stored items, and near-valid AttributeValue shapes that stress the decoder.

import fc from 'fast-check';

import type { Condition, StoredItem, TableRole, WriteAction } from '../../../src/durable-store/item-store-port.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';

/** Numbers the store accepts: finite, safe when integral, and zero or of magnitude ≥ 1E-130. */
export const storableNumber: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
  fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .filter(
      (value) =>
        (!Number.isInteger(value) || Number.isSafeInteger(value)) && (value === 0 || Math.abs(value) >= 1e-130),
    ),
);

/** Attribute names, biased toward names that break naive object handling. */
export const attributeName: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 1, maxLength: 8 }),
  fc.constantFrom('__proto__', 'constructor', 'toString', 'state', 'version', 'N', 'S'),
);

/** JSON values the store can hold exactly. */
export const storableJson: fc.Arbitrary<JsonValue> = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.string({ maxLength: 12 }),
    storableNumber,
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(attributeName, tie('value'), { maxKeys: 4 }),
  ),
})).value;

/** Items with non-empty keys and storable attributes. */
export const storedItem: fc.Arbitrary<StoredItem> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 16 }),
    fc.string({ minLength: 1, maxLength: 16 }),
    fc.dictionary(attributeName, storableJson, { maxKeys: 5 }),
  )
  .map(([pk, sk, attributes]) => ({ ...attributes, pk, sk }));

/**
 * A storable value nested 0 to 32 levels deep (the DynamoDB limit), as lists and maps around a
 * storable leaf, so round-trip properties reach the boundary that `depthSize: 'small'` never does.
 */
export const deeplyNestedStorableJson: fc.Arbitrary<JsonValue> = fc
  .tuple(
    fc.array(fc.constantFrom('L', 'M'), { maxLength: 32 }),
    attributeName,
    fc.oneof(fc.constant(null), fc.boolean(), fc.string({ maxLength: 12 }), storableNumber),
  )
  .map(([levels, name, leaf]) =>
    levels.reduceRight<JsonValue>((inner, level) => (level === 'L' ? [inner] : { [name]: inner }), leaf),
  );

/**
 * AttributeValues nested 0 to 5,000 levels, parsed from JSON text the way an untrusted event
 * arrives; deep enough that a recursive decoder without a bound would overflow the stack.
 */
export const deepAttributeValueLike: fc.Arbitrary<unknown> = fc
  .tuple(
    fc.integer({ min: 0, max: 5_000 }),
    fc.constantFrom('L', 'M'),
    fc.constantFrom('{"S":"x"}', '{"N":"1"}', '{"X":1}'),
  )
  .map(([depth, member, leaf]) => {
    const [open, close] = member === 'L' ? ['{"L":[', ']}'] : ['{"M":{"k":', '}}'];
    return JSON.parse(`${open.repeat(depth)}${leaf}${close.repeat(depth)}`) as unknown;
  });

/** Arbitrary values shaped roughly like AttributeValues, valid or not. */
export const attributeValueLike: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.anything(),
    fc.record({ S: fc.oneof(fc.string(), fc.anything()) }),
    fc.record({ N: fc.oneof(fc.string(), fc.stringMatching(/^-?\d{1,20}(\.\d{1,4})?(e[+-]?\d{1,3})?$/)) }),
    fc.record({ BOOL: fc.anything() }),
    fc.record({ NULL: fc.anything() }),
    fc.record({ L: fc.array(tie('value'), { maxLength: 3 }) }),
    fc.record({ M: fc.dictionary(attributeName, tie('value'), { maxKeys: 3 }) }),
    fc.dictionary(fc.constantFrom('S', 'N', 'BOOL', 'NULL', 'L', 'M', 'SS', 'B'), tie('value'), { maxKeys: 3 }),
  ),
})).value;

const conditionLeaf: fc.Arbitrary<Condition> = fc.oneof(
  fc.constant({ kind: 'item_absent' } as const),
  fc.record({
    kind: fc.constant('attribute_equals' as const),
    name: fc.oneof(attributeName, fc.constant('')),
    value: fc.oneof(fc.string({ maxLength: 8 }), fc.double(), fc.boolean()),
  }),
  fc.record({
    kind: fc.constant('attribute_in' as const),
    name: fc.oneof(attributeName, fc.constant('')),
    values: fc.array(fc.string({ maxLength: 4 }), { maxLength: 110 }),
  }),
);

/**
 * Conditions of every shape the validator must survive: shallow trees, single-member chains up
 * to 100,000 levels (past the 2043-level bound) and `all` lists up to 400 members wide (past the
 * 300-operator limit), with valid and invalid leaves.
 */
export const hostileCondition: fc.Arbitrary<Condition> = fc.oneof(
  fc.letrec<{ condition: Condition }>((tie) => ({
    condition: fc.oneof(
      { depthSize: 'small' },
      conditionLeaf,
      fc.record({ kind: fc.constant('all' as const), conditions: fc.array(tie('condition'), { maxLength: 4 }) }),
    ),
  })).condition,
  fc
    .tuple(fc.integer({ min: 0, max: 100_000 }), conditionLeaf)
    .map(([depth, leaf]) =>
      Array.from({ length: depth }).reduce<Condition>((inner) => ({ kind: 'all', conditions: [inner] }), leaf),
    ),
  fc.array(conditionLeaf, { maxLength: 400 }).map((conditions): Condition => ({ kind: 'all', conditions })),
);

const tableRole: fc.Arbitrary<TableRole> = fc.constantFrom('ledger', 'control', 'caller_journal');
const keyPart: fc.Arbitrary<string> = fc.oneof(fc.string({ minLength: 1, maxLength: 6 }), fc.constant(''));

/** Write actions with hostile conditions, possibly invalid keys, names and values. */
export const hostileWriteAction: fc.Arbitrary<WriteAction> = fc.oneof(
  fc.record(
    {
      kind: fc.constant('put' as const),
      table: tableRole,
      item: fc
        .tuple(keyPart, keyPart, fc.dictionary(attributeName, storableJson, { maxKeys: 3 }))
        .map(([pk, sk, attributes]): StoredItem => ({ ...attributes, pk, sk })),
      condition: hostileCondition,
    },
    { requiredKeys: ['kind', 'table', 'item'] },
  ),
  fc.record({
    kind: fc.constant('update' as const),
    table: tableRole,
    key: fc.record({ pk: keyPart, sk: keyPart }),
    set: fc.dictionary(fc.oneof(attributeName, fc.constant('pk')), storableJson, { maxKeys: 3 }),
    increment: fc.dictionary(attributeName, fc.oneof(fc.integer(), fc.double()), { maxKeys: 2 }),
    condition: hostileCondition,
  }),
  fc.record({
    kind: fc.constant('condition_check' as const),
    table: tableRole,
    key: fc.record({ pk: keyPart, sk: keyPart }),
    condition: hostileCondition,
  }),
);
