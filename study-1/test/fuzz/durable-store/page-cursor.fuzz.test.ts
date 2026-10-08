// Page cursor properties (testing rule 6: a decoder of untrusted cursor text): round trip,
// partition binding and totality. The example cases are in test/unit/durable-store/page-cursor.test.ts;
// the properties live here so `npm run test:fuzz` and `fuzz:campaign` reach them (Owner amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { decodePageCursor, encodePageCursor } from '../../../src/durable-store/page-cursor.ts';
import { keyViolations } from '../../../src/durable-store/write-action-validation.ts';
import { base64url, MAX_ERROR_LENGTH } from '../../support/durable-store/page-cursor-text.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

describe('page cursor properties', () => {
  it('round-trips every valid key and decodes only for its own partition', () => {
    const wellFormed = fc.oneof(fc.string(), fc.string({ unit: 'grapheme' }));
    fc.assert(
      fc.property(wellFormed, wellFormed, wellFormed, (pk, sk, otherPk) => {
        const cursor = encodePageCursor({ pk, sk });
        const validKey = keyViolations({ pk, sk }, 'cursor').length === 0;
        assert.equal(decodePageCursor(cursor, pk).ok, validKey);
        if (validKey) {
          assert.deepEqual(decodePageCursor(cursor, pk), { ok: true, value: { pk, sk } });
        }
        assert.equal(decodePageCursor(cursor, otherPk).ok, otherPk === pk && validKey);
      }),
      fuzzParameters(),
    );
  });

  it('decoding is total over arbitrary strings', () => {
    // Base64url of JSON documents, some nesting thousands of levels, reaches the payload checks
    // that plain random strings almost never reach.
    const nestedJson = fc
      .tuple(fc.integer({ min: 0, max: 20_000 }), fc.constantFrom('[', '{"a":'), fc.boolean())
      .map(([depth, open, asSk]) => {
        const close = open === '[' ? ']' : '}';
        const value = `${open.repeat(depth)}${open === '[' ? '' : '0'}${close.repeat(depth)}`;
        return base64url(asSk ? `{"pk":"p","sk":${value}}` : `{"pk":"p","sk":"s","x":${value}}`);
      });
    const jsonCursor = fc.json().map((text) => base64url(text));
    const cursors = fc.oneof(
      fc.string(),
      fc.base64String(),
      fc.stringMatching(/^[A-Za-z0-9_-]{0,40}$/),
      nestedJson,
      jsonCursor,
    );
    fc.assert(
      fc.property(cursors, (cursor) => {
        const decoded = decodePageCursor(cursor, 'p');
        if (decoded.ok) {
          assert.equal(decoded.value.pk, 'p');
          assert.equal(typeof decoded.value.sk, 'string');
          return;
        }
        assert.ok(decoded.error.includes('expected'), decoded.error);
        assert.ok(decoded.error.length < MAX_ERROR_LENGTH, decoded.error);
      }),
      fuzzParameters(),
    );
  });
});
