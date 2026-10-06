// The billing export reader (design §5.3 `parseCurCsv`, BR-RUA-047): RFC 4180 records over strict
// UTF-8, gzip or plain, total on any bytes (A-05). Every refusal is one CUR_EXPORT_MALFORMED reason
// that names the record and the expected shape.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { CUR_EXPORT_MAX_BYTES, decompressCurExport, parseCurCsv } from '../../../src/billing-amendment/cur-csv.ts';
import type { CurTable } from '../../../src/billing-amendment/cur-csv.ts';
import { csvBytes } from './support/cur-export-builder.ts';

function table(text: string): CurTable {
  const parsed = parseCurCsv(csvBytes(text));
  assert.ok(parsed.ok, `expected ${JSON.stringify(text)} to parse: ${JSON.stringify(parsed)}`);
  return parsed.value;
}

function refusal(bytes: Uint8Array): string {
  const parsed = parseCurCsv(bytes);
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok);
  assert.equal(parsed.error.code, 'CUR_EXPORT_MALFORMED');
  assert.equal(parsed.error.subject, 'BR-RUA-047');
  return parsed.error.detail;
}

describe('parseCurCsv accepts RFC 4180 exports', () => {
  it('reads the header and CRLF records', () => {
    assert.deepEqual(table('a,b\r\n1,2\r\n3,4\r\n'), {
      columns: ['a', 'b'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
    });
  });

  it('reads LF records and a last record without a terminator', () => {
    assert.deepEqual(table('a,b\n1,2\n3,4'), {
      columns: ['a', 'b'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
    });
  });

  it('reads quoted fields with commas, doubled quotes and line breaks', () => {
    assert.deepEqual(table('a,b,c\r\n"x,y","say ""hi""","l1\r\nl2\nl3\r"\r\n'), {
      columns: ['a', 'b', 'c'],
      rows: [['x,y', 'say "hi"', 'l1\r\nl2\nl3\r']],
    });
    assert.deepEqual(table('a,b,c\n"",,""\n'), { columns: ['a', 'b', 'c'], rows: [['', '', '']] });
  });

  it('reads a comma at the very end of the text as an empty last field', () => {
    assert.deepEqual(table('a,b\n1,'), { columns: ['a', 'b'], rows: [['1', '']] });
    assert.deepEqual(table('a,b\n1,\n'), { columns: ['a', 'b'], rows: [['1', '']] });
  });

  it('reads a header-only export as zero records', () => {
    assert.deepEqual(table('a,b\r\n'), { columns: ['a', 'b'], rows: [] });
  });

  it('drops a leading UTF-8 byte order mark', () => {
    assert.deepEqual(table('﻿a,b\n1,2\n'), { columns: ['a', 'b'], rows: [['1', '2']] });
  });

  it('reads gzip-compressed exports exactly like their plain bytes', () => {
    const text = 'a,b\r\n"q,1",2\r\n';
    assert.deepEqual(parseCurCsv(gzipSync(csvBytes(text))), parseCurCsv(csvBytes(text)));
  });

  it('keeps inherited member names as ordinary columns and cells (A-05)', () => {
    assert.deepEqual(table('__proto__,constructor,toString\nhasOwnProperty,valueOf,isPrototypeOf\n'), {
      columns: ['__proto__', 'constructor', 'toString'],
      rows: [['hasOwnProperty', 'valueOf', 'isPrototypeOf']],
    });
  });
});

describe('parseCurCsv refuses malformed exports with the record and the expected shape', () => {
  it('refuses an empty export', () => {
    assert.equal(refusal(new Uint8Array()), 'the export is empty; expected a header record of column names');
  });

  it('refuses invalid UTF-8 with its byte offset', () => {
    assert.equal(refusal(Uint8Array.from([0x61, 0xff])), 'invalid UTF-8 at byte 1; expected UTF-8 CSV text');
  });

  it('refuses a bare CR outside quotes', () => {
    assert.equal(
      refusal(csvBytes('a\rb\n')),
      'record 1: unexpected "\\r" at character 1; expected a comma, CRLF or LF after the field',
    );
  });

  it('refuses a quote inside an unquoted field', () => {
    assert.equal(
      refusal(csvBytes('a\nx"y\n')),
      'record 2: quote inside an unquoted field at character 3; expected the field quoted',
    );
  });

  it('refuses an unterminated quote', () => {
    assert.equal(
      refusal(csvBytes('a\n"abc\n')),
      'record 2: quote opened at character 2 is never closed; expected a closing quote',
    );
  });

  it('refuses text after a closing quote', () => {
    assert.equal(
      refusal(csvBytes('"a"b\n')),
      'record 1: unexpected "b" at character 3; expected a comma, CRLF or LF after the field',
    );
  });

  it('refuses a record whose field count differs from the header', () => {
    assert.equal(refusal(csvBytes('a,b\n1,2\n3\n')), 'record 3 has 1 field(s); expected 2, one per header column');
    assert.equal(refusal(csvBytes('a,b\n1,2,3\n')), 'record 2 has 3 field(s); expected 2, one per header column');
  });

  it('refuses an empty header column', () => {
    assert.equal(refusal(csvBytes('a,,b\n')), 'header column 2 is empty; expected a column name');
    assert.equal(refusal(csvBytes('\n')), 'header column 1 is empty; expected a column name');
  });

  it('refuses a repeated header column', () => {
    assert.equal(refusal(csvBytes('a,b,a\n')), 'header column "a" appears twice; expected unique column names');
  });

  it('refuses gzip bytes that do not decompress', () => {
    const detail = refusal(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02]));
    assert.match(
      detail,
      /^gzip data cannot be decompressed \(.+\); expected a complete gzip stream of at most 67108864 bytes$/,
    );
  });

  it('refuses a gzip export that decompresses past the size bound instead of truncating it', () => {
    const oversized = gzipSync(new Uint8Array(CUR_EXPORT_MAX_BYTES + 1));
    assert.match(refusal(oversized), /^gzip data cannot be decompressed/);
    assert.equal(decompressCurExport(gzipSync(new Uint8Array(CUR_EXPORT_MAX_BYTES))).ok, true);
  });
});

describe('decompressCurExport', () => {
  it('passes bytes without the full gzip magic through unchanged', () => {
    const plain = Uint8Array.from([0x1f, 0x41]);
    assert.deepEqual(decompressCurExport(plain), { ok: true, value: plain });
    const single = Uint8Array.from([0x8b]);
    assert.deepEqual(decompressCurExport(single), { ok: true, value: single });
  });
});

describe('parseCurCsv is iterative on hostile shapes (A-05)', () => {
  it('reads a quoted field of 100,000 doubled quotes', () => {
    const quotes = '""'.repeat(100_000);
    assert.deepEqual(table(`a\n"${quotes}"\n`).rows, [['"'.repeat(100_000)]]);
  });

  it('reads 100,000 columns and 100,000 records', () => {
    const header = Array.from({ length: 100_000 }, (_, index) => `c${String(index)}`).join(',');
    assert.equal(table(`${header}\n`).columns.length, 100_000);
    const rows = table(`a\n${'x\n'.repeat(100_000)}`).rows;
    assert.equal(rows.length, 100_000);
  });
});
