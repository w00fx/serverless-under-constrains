// Design §12.5 row `parseCurCsv` (WP-18, A-05, A-11): the export reader is total over arbitrary
// gzip and CSV bytes, and every RFC 4180 table it is given back as CSV reads back unchanged.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import fc from 'fast-check';

import { parseCurCsv } from '../../../src/billing-amendment/cur-csv.ts';
import type { CurTable } from '../../../src/billing-amendment/cur-csv.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { csvField } from '../../unit/billing-amendment/support/cur-export-builder.ts';

const encoder = new TextEncoder();

function assertTotal(bytes: Uint8Array): void {
  const parsed = parseCurCsv(bytes);
  if (!parsed.ok) {
    assert.equal(parsed.error.code, 'CUR_EXPORT_MALFORMED');
    assert.ok(parsed.error.detail.length > 0);
  }
}

// Characters that exercise every separator and quoting rule, plus multi-byte text.
const cellText = fc.string({
  unit: fc.constantFrom('a', 'Z', '0', ' ', ',', '"', '\r', '\n', 'é', '日', '😀', '_'),
  maxLength: 8,
});

const tableArbitrary: fc.Arbitrary<CurTable> = fc
  .uniqueArray(
    cellText.filter((name) => name.length > 0),
    { minLength: 1, maxLength: 5 },
  )
  .chain((columns) =>
    fc
      .array(fc.array(cellText, { minLength: columns.length, maxLength: columns.length }), { maxLength: 6 })
      .map((rows) => ({ columns, rows })),
  );

function quoteAll(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe('parseCurCsv is total over arbitrary export bytes (property)', () => {
  it('returns a table or one CUR_EXPORT_MALFORMED reason for any bytes', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 512 }), assertTotal), fuzzParameters());
  });

  it('returns a table or one reason for gzip of any bytes and for gzip magic followed by any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        assertTotal(gzipSync(bytes));
        assertTotal(Uint8Array.from([0x1f, 0x8b, ...bytes]));
      }),
      fuzzParameters(),
    );
  });

  it('returns a table or one reason for any text over the CSV alphabet', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('a', ',', '"', '\r', '\n', 'é'), maxLength: 64 }), (text) => {
        assertTotal(encoder.encode(text));
      }),
      fuzzParameters(),
    );
  });
});

describe('parseCurCsv reads back every table written as RFC 4180 (property)', () => {
  it('with minimal quoting and a terminator after every record, CRLF or LF, plain or gzip', () => {
    fc.assert(
      fc.property(tableArbitrary, fc.constantFrom('\r\n', '\n'), fc.boolean(), (table, terminator, compress) => {
        const text = [table.columns, ...table.rows]
          .map((fields) => fields.map(csvField).join(',') + terminator)
          .join('');
        const bytes = encoder.encode(text);
        assert.deepEqual(parseCurCsv(compress ? gzipSync(bytes) : bytes), { ok: true, value: table });
      }),
      fuzzParameters(),
    );
  });

  it('with every field quoted and no terminator after the last record', () => {
    fc.assert(
      fc.property(tableArbitrary, (table) => {
        const text = [table.columns, ...table.rows].map((fields) => fields.map(quoteAll).join(',')).join('\r\n');
        assert.deepEqual(parseCurCsv(encoder.encode(text)), { ok: true, value: table });
      }),
      fuzzParameters(),
    );
  });
});
