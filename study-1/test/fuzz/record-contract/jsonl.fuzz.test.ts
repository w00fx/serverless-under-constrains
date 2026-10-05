// AC-RUA-046 fuzz: the JSONL parser is total, returns one entry per 0x0A-delimited line, and
// round-trips canonical JSONL.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { canonicalJson, serializeJsonl, structurallyEqual } from '../../../src/record-contract/canonical-json.ts';
import { parseJsonDocument, parseJsonl } from '../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../src/record-contract/records/index.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const encoder = new TextEncoder();

const chunk = fc.oneof(
  fc.uint8Array({ maxLength: 16 }),
  fc.jsonValue({ maxDepth: 2 }).map((value) => encoder.encode(JSON.stringify(value))),
  fc.constant(Uint8Array.of(0x0a)),
  fc.constant(Uint8Array.of(0x0d, 0x0a)),
);
const jsonlBytes = fc
  .array(chunk, { maxLength: 12 })
  .map((chunks) => Uint8Array.from(chunks.flatMap((part) => [...part])));

function splitLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  bytes.forEach((byte, index) => {
    if (byte === 0x0a) {
      lines.push(bytes.subarray(start, index));
      start = index + 1;
    }
  });
  if (start < bytes.length) {
    lines.push(bytes.subarray(start));
  }
  return lines;
}

const record = fc
  .dictionary(fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/), fc.jsonValue({ maxDepth: 2 }), {
    maxKeys: 4,
    noNullPrototype: true,
  })
  .map((fields) => ({ ...fields, schema_version: 1, record_type: 'ledger_snapshot' }) as unknown as StudyRecord);

describe('AC-RUA-046 JSONL parser fuzz', () => {
  it('parsers never throw and return one entry per line', () => {
    fc.assert(
      fc.property(jsonlBytes, (bytes) => {
        const report = parseJsonl(bytes);
        const expected = splitLines(bytes);
        assert.equal(report.lines.length, expected.length);
        assert.equal(report.ends_with_newline, bytes.length > 0 && bytes[bytes.length - 1] === 0x0a);
        report.lines.forEach((line, index) => {
          assert.equal(line.line_number, index + 1);
          const alone = parseJsonDocument(expected[index] ?? new Uint8Array());
          assert.equal(line.parsed.ok, alone.ok);
          assert.ok(!line.parsed.ok || (alone.ok && structurallyEqual(line.parsed.value, alone.value)));
        });
        const firstDecodeError = report.lines
          .map((line) => line.parsed)
          .find((parsed) => !parsed.ok && parsed.error.kind === 'invalid_utf8');
        assert.deepEqual(
          report.decode_error,
          firstDecodeError === undefined || firstDecodeError.ok ? undefined : firstDecodeError.error,
        );
      }),
      fuzzParameters(),
    );
  });

  it('round-trips canonical JSONL record by record', () => {
    fc.assert(
      fc.property(fc.array(record, { maxLength: 8 }), (records) => {
        const report = parseJsonl(serializeJsonl(records));
        assert.equal(report.lines.length, records.length);
        assert.equal(report.ends_with_newline, records.length > 0);
        report.lines.forEach((line, index) => {
          assert.ok(line.parsed.ok);
          assert.equal(canonicalJson(line.parsed.value), canonicalJson(records[index] as unknown as JsonValue));
        });
      }),
      fuzzParameters(),
    );
  });
});
