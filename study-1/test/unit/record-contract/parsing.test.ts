// Total parsers over evidence bytes (BR-RUA-033, AC-RUA-046). The UTF-8 validator is checked
// exhaustively against the platform's fatal TextDecoder, the reference implementation of the
// WHATWG UTF-8 decoder (which follows Unicode Table 3-7).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeUtf8Strict,
  firstInvalidUtf8Offset,
  parseJsonDocument,
  parseJsonl,
} from '../../../src/record-contract/parsing.ts';

const encoder = new TextEncoder();
const fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function platformAccepts(bytes: Uint8Array): boolean {
  try {
    fatal.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

describe('firstInvalidUtf8Offset', () => {
  it('agrees with the fatal TextDecoder on every lead and second byte pair', () => {
    const tails: readonly (readonly number[])[] = [[], [0x80], [0x80, 0x80], [0xbf, 0xbf], [0x7f, 0x80], [0x80, 0xc0]];
    const everyByte = Array.from({ length: 256 }, (_, byte) => byte);
    const inputs = everyByte.flatMap((lead) =>
      everyByte.flatMap((second) => tails.map((tail) => Uint8Array.of(lead, second, ...tail))),
    );
    const disagreements = inputs
      .filter((bytes) => (firstInvalidUtf8Offset(bytes) === -1) !== platformAccepts(bytes))
      .map((bytes) => Buffer.from(bytes).toString('hex'));
    assert.equal(inputs.length, 256 * 256 * 6);
    assert.deepEqual(disagreements.slice(0, 10), []);
  });

  it('points at the first byte of the first ill-formed sequence', () => {
    assert.equal(firstInvalidUtf8Offset(Uint8Array.of()), -1);
    assert.equal(firstInvalidUtf8Offset(encoder.encode('aé€\u{1F600}')), -1);
    assert.equal(firstInvalidUtf8Offset(Uint8Array.of(0x61, 0xc0, 0x80)), 1);
    assert.equal(firstInvalidUtf8Offset(Uint8Array.of(0x61, 0x62, 0xe2, 0x82)), 2);
    assert.equal(firstInvalidUtf8Offset(Uint8Array.of(0xe2, 0x82, 0xac, 0xff)), 3);
    assert.equal(firstInvalidUtf8Offset(Uint8Array.of(0xf0, 0x9f, 0x98, 0x80, 0xed, 0xa0, 0x80)), 4);
    assert.equal(firstInvalidUtf8Offset(Uint8Array.of(0xf4, 0x90, 0x80, 0x80)), 0);
    assert.equal(firstInvalidUtf8Offset(Uint8Array.of(0xf0, 0x90, 0x80)), 0);
    assert.equal(firstInvalidUtf8Offset(Uint8Array.of(0xf0, 0x90, 0x80, 0x7f)), 0);
  });
});

describe('decodeUtf8Strict', () => {
  it('decodes well-formed bytes and keeps a byte-order mark as text', () => {
    assert.deepEqual(decodeUtf8Strict(encoder.encode('{"a":"é"}')), { ok: true, value: '{"a":"é"}' });
    assert.deepEqual(decodeUtf8Strict(Uint8Array.of(0xef, 0xbb, 0xbf, 0x31)), { ok: true, value: '﻿1' });
  });

  it('reports the offset of an ill-formed sequence', () => {
    assert.deepEqual(decodeUtf8Strict(Uint8Array.of(0x7b, 0xff)), {
      ok: false,
      error: { kind: 'invalid_utf8', byte_offset: 1 },
    });
  });
});

describe('parseJsonDocument', () => {
  it('parses a JSON document from bytes, tolerating insignificant whitespace', () => {
    assert.deepEqual(parseJsonDocument(encoder.encode(' {"a":[1,true,null]}\n')), {
      ok: true,
      value: { a: [1, true, null] },
    });
  });

  it('reports invalid UTF-8 before attempting JSON', () => {
    assert.deepEqual(parseJsonDocument(Uint8Array.of(0x22, 0xc3, 0x22)), {
      ok: false,
      error: { kind: 'invalid_utf8', byte_offset: 1 },
    });
  });

  it('reports malformed JSON with the parser message', () => {
    const parsed = parseJsonDocument(encoder.encode('{"a":'));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.kind, 'invalid_json');
    assert.match(parsed.error.detail, /JSON/);
    assert.equal(parseJsonDocument(encoder.encode('')).ok, false);
    assert.equal(parseJsonDocument(Uint8Array.of(0xef, 0xbb, 0xbf, 0x31)).ok, false);
  });

  it('rejects numbers that overflow a finite double, naming their JSON pointer', () => {
    assert.deepEqual(parseJsonDocument(encoder.encode('1e400')), {
      ok: false,
      error: { kind: 'invalid_json', detail: 'number at JSON pointer "" overflows a finite double' },
    });
    assert.deepEqual(parseJsonDocument(encoder.encode('{"a/b":{"c~d":[0,-1e999]}}')), {
      ok: false,
      error: { kind: 'invalid_json', detail: 'number at JSON pointer "/a~1b/c~0d/1" overflows a finite double' },
    });
  });

  it('checks numbers in nesting deeper than the call stack without throwing', () => {
    const depth = 200_000;
    assert.equal(parseJsonDocument(encoder.encode(`${'['.repeat(depth)}1${']'.repeat(depth)}`)).ok, true);
    const overflow = parseJsonDocument(encoder.encode(`${'['.repeat(depth)}1e999${']'.repeat(depth)}`));
    assert.equal(
      !overflow.ok && overflow.error.kind === 'invalid_json' && overflow.error.detail,
      `number at JSON pointer "${'/0'.repeat(depth)}" overflows a finite double`,
    );
  });
});

describe('parseJsonl', () => {
  it('returns one entry per newline-terminated line', () => {
    const report = parseJsonl(encoder.encode('{"a":1}\n[2]\n'));
    assert.deepEqual(report, {
      lines: [
        { line_number: 1, parsed: { ok: true, value: { a: 1 } } },
        { line_number: 2, parsed: { ok: true, value: [2] } },
      ],
      ends_with_newline: true,
    });
  });

  it('keeps an unterminated last line and reports the missing final newline', () => {
    const report = parseJsonl(encoder.encode('1\n2'));
    assert.deepEqual(
      report.lines.map((line) => line.line_number),
      [1, 2],
    );
    assert.equal(report.ends_with_newline, false);
  });

  it('parses each line independently so a corrupt line hides nothing', () => {
    const report = parseJsonl(encoder.encode('1\n\n{bad\n4\n'));
    assert.deepEqual(
      report.lines.map((line) => line.parsed.ok),
      [true, false, false, true],
    );
    assert.equal(report.decode_error, undefined);
    assert.equal('decode_error' in report, false);
  });

  it('treats an empty file as zero lines and a lone newline as one empty line', () => {
    assert.deepEqual(parseJsonl(new Uint8Array()), { lines: [], ends_with_newline: false });
    const lone = parseJsonl(encoder.encode('\n'));
    assert.equal(lone.lines.length, 1);
    assert.equal(lone.lines[0]?.parsed.ok, false);
    assert.equal(lone.ends_with_newline, true);
  });

  it('reports decode errors per line with file-relative offsets and the first one at report level', () => {
    const bytes = Uint8Array.of(0x31, 0x0a, 0x22, 0xff, 0x22, 0x0a, 0x32, 0x0a, 0xc0, 0x0a);
    const report = parseJsonl(bytes);
    assert.deepEqual(report.lines[1]?.parsed, { ok: false, error: { kind: 'invalid_utf8', byte_offset: 3 } });
    assert.deepEqual(report.lines[3]?.parsed, { ok: false, error: { kind: 'invalid_utf8', byte_offset: 8 } });
    assert.deepEqual(report.decode_error, { kind: 'invalid_utf8', byte_offset: 3 });
    assert.equal(report.lines.length, 4);
  });

  it('accepts CRLF line endings as JSON whitespace', () => {
    assert.deepEqual(
      parseJsonl(encoder.encode('1\r\n2\r\n')).lines.map((line) => line.parsed),
      [
        { ok: true, value: 1 },
        { ok: true, value: 2 },
      ],
    );
  });
});
