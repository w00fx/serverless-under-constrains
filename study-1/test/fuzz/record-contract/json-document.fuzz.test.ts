// AC-RUA-046 fuzz: the JSON document parser is total over arbitrary bytes and agrees with the
// platform's fatal UTF-8 decoder and JSON.parse (independent reference implementations).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { structurallyEqual } from '../../../src/record-contract/canonical-json.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function referenceDecode(bytes: Uint8Array): string | undefined {
  try {
    return fatal.decode(bytes);
  } catch {
    return undefined;
  }
}

// Biases generation toward the bytes that matter: JSON punctuation, multi-byte lead and
// continuation bytes, and the boundary bytes of Unicode Table 3-7.
const interestingByte = fc.oneof(
  fc.integer({ min: 0, max: 255 }),
  fc.constantFrom(0x22, 0x5b, 0x5d, 0x7b, 0x7d, 0x3a, 0x2c, 0x31, 0x65, 0x2d, 0x0a, 0x5c),
  fc.constantFrom(0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff),
);
const arbitraryBytes = fc.oneof(
  fc.uint8Array({ maxLength: 64 }),
  fc.array(interestingByte, { maxLength: 64 }).map((bytes) => Uint8Array.from(bytes)),
  fc.jsonValue().map((value) => encoder.encode(JSON.stringify(value))),
);

describe('AC-RUA-046 JSON document parser fuzz', () => {
  it('parsers never throw and agree with the reference decoder and JSON.parse', () => {
    fc.assert(
      fc.property(arbitraryBytes, (bytes) => {
        const parsed = parseJsonDocument(bytes);
        const text = referenceDecode(bytes);
        if (text === undefined) {
          assert.equal(!parsed.ok && parsed.error.kind, 'invalid_utf8');
          const offset = !parsed.ok && parsed.error.kind === 'invalid_utf8' ? parsed.error.byte_offset : -1;
          assert.notEqual(
            referenceDecode(bytes.subarray(0, offset)),
            undefined,
            'bytes before the reported offset are well-formed',
          );
          assert.equal(
            referenceDecode(bytes.subarray(0, offset + 4)),
            undefined,
            'the reported sequence is ill-formed',
          );
          return;
        }
        let reference: JsonValue | undefined;
        try {
          reference = JSON.parse(text) as JsonValue;
        } catch {
          reference = undefined;
        }
        if (parsed.ok) {
          assert.ok(reference !== undefined && structurallyEqual(parsed.value, reference));
          return;
        }
        assert.equal(parsed.error.kind, 'invalid_json');
      }),
      fuzzParameters(),
    );
  });

  it('round-trips every JSON value', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const parsed = parseJsonDocument(encoder.encode(JSON.stringify(value)));
        assert.ok(parsed.ok && structurallyEqual(parsed.value, value as JsonValue));
      }),
      fuzzParameters(),
    );
  });

  it('never reports invalid UTF-8 for encoded text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 64 }), (text) => {
        const parsed = parseJsonDocument(encoder.encode(text));
        assert.ok(parsed.ok || parsed.error.kind === 'invalid_json');
      }),
      fuzzParameters(),
    );
  });
});
