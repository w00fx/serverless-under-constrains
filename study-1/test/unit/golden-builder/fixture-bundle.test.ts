// The golden fixture bundle (close-out): one committed file per case, each evidence file kept as
// its lines, or as base64 when it is not UTF-8. The exact canonical text, the exact bytes it
// decodes back to, and every shape the decoder refuses, with the message that names it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeFixtureBundle, encodeFixtureBundle } from '../../../tools/golden/lib/fixture-bundle.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FILES = new Map<string, Uint8Array>([
  ['z.json', new Uint8Array()],
  ['c.bin', Uint8Array.of(0xff, 0x00)],
  ['a/b.jsonl', encoder.encode('{"x":1}\n{"y":2}\n')],
]);
const CANONICAL = `{
  "a/b.jsonl": [
    "{\\"x\\":1}",
    "{\\"y\\":2}",
    ""
  ],
  "c.bin": {
    "base64": "/wA="
  },
  "z.json": [
    ""
  ]
}
`;

const refusal = (text: string): string => {
  const decoded = decodeFixtureBundle(encoder.encode(text));
  return decoded.ok ? '<decoded>' : decoded.error;
};
const MEMBER_SHAPE = 'expected a non-empty array of lines without a newline, or {"base64": <canonical base64>}';

describe('encodeFixtureBundle', () => {
  it('writes the files sorted by path, text as lines and other bytes as base64, two-space JSON and a final newline', () => {
    assert.equal(decoder.decode(encodeFixtureBundle(FILES)), CANONICAL);
  });

  it('writes no files as an empty object', () => {
    assert.equal(decoder.decode(encodeFixtureBundle(new Map())), '{}\n');
  });
});

describe('decodeFixtureBundle', () => {
  it('restores the exact bytes of every file', () => {
    assert.deepEqual(decodeFixtureBundle(encoder.encode(CANONICAL)), { ok: true, value: FILES });
    assert.deepEqual(decodeFixtureBundle(encoder.encode('{}')), { ok: true, value: new Map() });
  });

  it('refuses bytes that are not a JSON object', () => {
    assert.deepEqual(decodeFixtureBundle(Uint8Array.of(0x7b, 0xff)), {
      ok: false,
      error: 'the bundle does not parse (invalid UTF-8 at byte 1); expected a JSON object of files',
    });
    assert.match(refusal('{"a":'), /^the bundle does not parse \(.+\); expected a JSON object of files$/);
    assert.equal(refusal('["a"]'), 'the bundle is ["a"]; expected a JSON object of files');
    assert.equal(refusal('null'), 'the bundle is null; expected a JSON object of files');
  });

  it('refuses a member that is neither lines nor canonical base64, naming it', () => {
    const members: readonly (readonly [string, string])[] = [
      ['"x"', '"x"'],
      ['[]', '[]'],
      ['["a\\nb"]', '["a\\nb"]'],
      ['["a",1]', '["a",1]'],
      ['{"base64":1}', '{"base64":1}'],
      ['{"b64":"/w=="}', '{"b64":"/w=="}'],
      ['{"base64":"/w==","x":1}', '{"base64":"/w==","x":1}'],
      ['{"base64":"/w"}', '{"base64":"/w"}'],
      ['{"base64":"/w==\\n"}', '{"base64":"/w==\\n"}'],
    ];
    for (const [member, shown] of members) {
      assert.equal(refusal(`{"ok.json":[""],"p/q.json":${member}}`), `member p/q.json is ${shown}; ${MEMBER_SHAPE}`);
    }
  });

  it('accepts canonical base64 and empty base64', () => {
    assert.deepEqual(decodeFixtureBundle(encoder.encode('{"a":{"base64":"/w=="},"b":{"base64":""}}')), {
      ok: true,
      value: new Map([
        ['a', Uint8Array.of(0xff)],
        ['b', new Uint8Array()],
      ]),
    });
  });
});
