// Property tests of the AttributeValue codec (testing rule 6: serialization and a decoder of
// service output). Runs FC_RUNS cases (10,000 under `npm run test:fuzz` budgets).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  decodeAttributeValue,
  decodeStoredItem,
  encodeAttributeMap,
  encodeAttributeValue,
} from '../../../src/durable-store/attribute-value-codec.ts';
import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import { attributeValueLike, storableJson, storedItem } from '../../support/durable-store/arbitraries.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

describe('AttributeValue codec properties', () => {
  it('decode(encode(v)) is structurally equal to v for every storable JSON value', () => {
    fc.assert(
      fc.property(storableJson, (value) => {
        const decoded = decodeAttributeValue(encodeAttributeValue(value));
        assert.ok(decoded.ok);
        assert.equal(canonicalJson(decoded.value), canonicalJson(value));
      }),
      fuzzParameters(),
    );
  });

  it('every stored item round-trips with its keys', () => {
    fc.assert(
      fc.property(storedItem, (item) => {
        const decoded = decodeStoredItem(encodeAttributeMap(item));
        assert.ok(decoded.ok);
        assert.equal(canonicalJson(decoded.value), canonicalJson(item));
      }),
      fuzzParameters(),
    );
  });

  it('decoding is total and a success re-encodes to an equivalent AttributeValue', () => {
    fc.assert(
      fc.property(attributeValueLike, (input) => {
        const decoded = decodeAttributeValue(input);
        if (!decoded.ok) {
          assert.equal(typeof decoded.error, 'string');
          assert.ok(decoded.error.includes('expected'), decoded.error);
          return;
        }
        const again = decodeAttributeValue(encodeAttributeValue(decoded.value));
        assert.ok(again.ok);
        assert.equal(canonicalJson(again.value), canonicalJson(decoded.value));
      }),
      fuzzParameters(),
    );
  });
});
