// Opaque page cursors: canonical encoding, strict decoding, partition binding.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { decodePageCursor, encodePageCursor } from '../../../src/durable-store/page-cursor.ts';
import { keyViolations } from '../../../src/durable-store/write-action-validation.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

describe('encodePageCursor', () => {
  it('is base64url of canonical JSON of the key alone', () => {
    const cursor = encodePageCursor({ pk: 'run#trial', sk: 'tx#1' });
    assert.equal(cursor, 'eyJwayI6InJ1biN0cmlhbCIsInNrIjoidHgjMSJ9');
    assert.equal(Buffer.from(cursor, 'base64url').toString('utf8'), '{"pk":"run#trial","sk":"tx#1"}');
    const withExtras = { sk: 'tx#1', pk: 'run#trial', amount_minor: 10000 };
    assert.equal(encodePageCursor(withExtras), cursor);
  });
});

describe('decodePageCursor', () => {
  it('decodes a cursor of the same partition', () => {
    assert.deepEqual(decodePageCursor(encodePageCursor({ pk: 'p', sk: 's/é' }), 'p'), {
      ok: true,
      value: { pk: 'p', sk: 's/é' },
    });
  });

  it('refuses a cursor minted for another partition', () => {
    assert.deepEqual(decodePageCursor(encodePageCursor({ pk: 'other', sk: 's' }), 'p'), {
      ok: false,
      error: 'cursor belongs to partition "other"; expected partition "p"',
    });
  });

  it('refuses text that is not canonical base64url', () => {
    const cases = ['', 'A', 'AB', 'YQ==', 'ab+c', 'ab/c', 'a b', `${base64url('{"pk":"p","sk":"s"}')}=`];
    for (const cursor of cases) {
      assert.deepEqual(
        decodePageCursor(cursor, 'p'),
        {
          ok: false,
          error:
            cursor === ''
              ? 'cursor "" does not hold a JSON object; expected {"pk","sk"}'
              : `cursor ${JSON.stringify(cursor)} is not canonical base64url; expected a page cursor`,
        },
        cursor,
      );
    }
  });

  it('refuses payloads that are not exactly a string pk and sk', () => {
    const cases: readonly [string, string][] = [
      ['not json', 'does not hold a JSON object; expected {"pk","sk"}'],
      ['["p","s"]', 'does not hold a JSON object; expected {"pk","sk"}'],
      ['null', 'does not hold a JSON object; expected {"pk","sk"}'],
      ['{"pk":"p"}', 'holds members ["pk"] with pk a string and sk absent; expected exactly string pk and sk'],
      [
        '{"pk":"p","sk":1}',
        'holds members ["pk","sk"] with pk a string and sk a number; expected exactly string pk and sk',
      ],
      [
        '{"pk":1,"sk":"s"}',
        'holds members ["pk","sk"] with pk a number and sk a string; expected exactly string pk and sk',
      ],
      [
        '{"pk":"p","sk":"s","x":0}',
        'holds members ["pk","sk","x"] with pk a string and sk a string; expected exactly string pk and sk',
      ],
      [
        '{"pk":"p","x":"s"}',
        'holds members ["pk","x"] with pk a string and sk absent; expected exactly string pk and sk',
      ],
      [
        '{"pk":null,"sk":[true]}',
        'holds members ["pk","sk"] with pk null and sk an array; expected exactly string pk and sk',
      ],
      [
        '{"pk":false,"sk":{}}',
        'holds members ["pk","sk"] with pk a boolean and sk a map; expected exactly string pk and sk',
      ],
    ];
    for (const [payload, error] of cases) {
      const cursor = base64url(payload);
      assert.deepEqual(decodePageCursor(cursor, 'p'), {
        ok: false,
        error: `cursor ${JSON.stringify(cursor)} ${error}`,
      });
    }
    const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d]).toString('base64url');
    assert.equal(decodePageCursor(invalidUtf8, 'p').ok, false);
  });

  it('refuses a forged cursor whose sort key DynamoDB would refuse as ExclusiveStartKey', () => {
    assert.deepEqual(decodePageCursor(base64url('{"pk":"p","sk":""}'), 'p'), {
      ok: false,
      error: 'cursor: sk is ""; expected a non-empty well-formed string of at most 1024 UTF-8 bytes',
    });
    assert.deepEqual(decodePageCursor(base64url(`{"pk":"p","sk":"${'x'.repeat(1025)}"}`), 'p'), {
      ok: false,
      error: 'cursor: sk is 1025 UTF-8 bytes long; expected a non-empty well-formed string of at most 1024 UTF-8 bytes',
    });
    assert.equal(decodePageCursor(base64url(`{"pk":"p","sk":"${'x'.repeat(1024)}"}`), 'p').ok, true);
  });

  it('stays total on a payload with a deeply nested extra member and never echoes it (WP-04 review round 1)', () => {
    for (const depth of [10_000, 100_000]) {
      const cursor = base64url(`{"pk":"p","sk":"s","x":${'['.repeat(depth)}${']'.repeat(depth)}}`);
      assert.deepEqual(decodePageCursor(cursor, 'p'), {
        ok: false,
        error: `cursor ${JSON.stringify(cursor)} holds members ["pk","sk","x"] with pk a string and sk a string; expected exactly string pk and sk`,
      });
    }
    const nestedSk = base64url(`{"pk":"p","sk":${'['.repeat(100_000)}${']'.repeat(100_000)}}`);
    assert.deepEqual(decodePageCursor(nestedSk, 'p'), {
      ok: false,
      error: `cursor ${JSON.stringify(nestedSk)} holds members ["pk","sk"] with pk a string and sk an array; expected exactly string pk and sk`,
    });
  });

  it('accepts a hand-built cursor whose JSON is not canonical', () => {
    assert.deepEqual(decodePageCursor(base64url('{ "sk": "s", "pk": "p" }'), 'p'), {
      ok: true,
      value: { pk: 'p', sk: 's' },
    });
  });
});

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
      }),
      fuzzParameters(),
    );
  });
});
