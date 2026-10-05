// fast-check generators for the durable-store property tests (testing rule 6): storable JSON,
// stored items, and near-valid AttributeValue shapes that stress the decoder.

import fc from 'fast-check';

import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';

/** Numbers the store accepts: finite, and safe when integral. */
export const storableNumber: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
  fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .filter((value) => !Number.isInteger(value) || Number.isSafeInteger(value)),
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
