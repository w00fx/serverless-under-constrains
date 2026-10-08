// Property tests of the golden fixture bundle (close-out, testing rule 6: it serializes every
// golden fixture and parses the committed ones). Any files, text or not, under any paths, decode
// back to their exact bytes, and the encoding of what decodes is the bytes that were decoded; any
// input decodes or is refused without throwing, and what decodes re-encodes to a fixed point.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { decodeFixtureBundle, encodeFixtureBundle } from '../../../tools/golden/lib/fixture-bundle.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const encoder = new TextEncoder();
const content = fc.oneof(
  fc.uint8Array({ maxLength: 64 }),
  fc.string({ unit: 'binary', maxLength: 64 }).map((text) => encoder.encode(text)),
);
const files = fc
  .uniqueArray(fc.tuple(fc.string({ unit: 'binary', maxLength: 24 }), content), {
    selector: ([path]) => path,
    maxLength: 6,
  })
  .map((entries) => new Map(entries));

describe('fixture bundle over arbitrary files', () => {
  it('decodes to the exact files, and the decoded files encode to the same bytes', () => {
    fc.assert(
      fc.property(files, (input) => {
        const bundle = encodeFixtureBundle(input);
        const decoded = decodeFixtureBundle(bundle);
        assert.deepEqual(decoded, { ok: true, value: input });
        assert.deepEqual(encodeFixtureBundle(decoded.ok ? decoded.value : new Map()), bundle);
      }),
      fuzzParameters(),
    );
  });

  it('decodes or refuses any bytes and any JSON without throwing, and what decodes is a fixed point', () => {
    const input = fc.oneof(
      fc.uint8Array({ maxLength: 128 }),
      fc.jsonValue().map((value) => encoder.encode(JSON.stringify(value))),
      fc
        .dictionary(
          fc.string({ maxLength: 8 }),
          fc.oneof(fc.array(fc.string()), fc.record({ base64: fc.base64String() })),
        )
        .map((value) => encoder.encode(JSON.stringify(value))),
    );
    fc.assert(
      fc.property(input, (bytes) => {
        const decoded = decodeFixtureBundle(bytes);
        if (!decoded.ok) {
          assert.match(decoded.error, /; expected (a JSON object of files|a non-empty array of lines)/);
          return;
        }
        assert.deepEqual(decodeFixtureBundle(encodeFixtureBundle(decoded.value)), decoded);
      }),
      fuzzParameters(),
    );
  });
});
