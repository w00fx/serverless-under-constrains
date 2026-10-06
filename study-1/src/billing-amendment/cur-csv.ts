// The authoritative billing export reader (BR-RUA-047, design §5.3 `parseCurCsv`): a CUR 2.0 data
// export file, gzip-compressed or plain, decoded as strict UTF-8 and parsed by this project's own
// RFC 4180 reader (no CSV dependency, addendum §4). The function is total: any byte sequence gives
// a table or one structured reason, never an exception (A-05). Parsing is a single iterative pass,
// so neither deep quoting nor a huge field can exhaust the stack.
//
// Accepted shape: a header record of unique, non-empty column names, then data records with exactly
// as many fields. Records end with CRLF or LF (RFC 4180 says CRLF; exports and editors also write
// LF), the last terminator is optional, and a field containing a comma, a quote or a line break must
// be quoted, with an inner quote doubled. A bare CR, a quote inside an unquoted field, text after a
// closing quote and an unterminated quote are malformed.

import { gunzipSync } from 'node:zlib';

import { boundedJsonText, boundedText } from '../record-contract/json-value.ts';
import { decodeUtf8Strict } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';

/** The largest decompressed export accepted; a larger one is refused, never truncated. */
export const CUR_EXPORT_MAX_BYTES = 64 * 1024 * 1024;

/** A parsed export: the header's column names and every data record, all as exact text. */
export interface CurTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

const GZIP_MAGIC = [0x1f, 0x8b] as const;
const BYTE_ORDER_MARK = '﻿';
const QUOTE = 0x22;
const COMMA = 0x2c;
const CR = 0x0d;
const LF = 0x0a;

/** Mutable parser state of one pass over the text. */
interface ParseCursor {
  readonly text: string;
  index: number;
  record: string[];
  readonly records: string[][];
}

/**
 * Parses one billing export file (gzip or plain CSV bytes) into its header and records.
 *
 * @example
 * const table = parseCurCsv(exportBytes);
 * if (!table.ok) reasons.push(table.error); // CUR_EXPORT_MALFORMED with the record and the expected shape
 */
export function parseCurCsv(bytes: Uint8Array): Result<CurTable, StructuredReason> {
  const plain = decompressCurExport(bytes);
  if (!plain.ok) {
    return plain;
  }
  const text = decodeUtf8Strict(plain.value);
  if (!text.ok) {
    return err(malformed(`invalid UTF-8 at byte ${String(text.error.byte_offset)}; expected UTF-8 CSV text`));
  }
  // A byte order mark is encoding metadata, not part of the first column name.
  const records = parseRecords(text.value.startsWith(BYTE_ORDER_MARK) ? text.value.slice(1) : text.value);
  return records.ok ? tableOf(records.value) : records;
}

/**
 * Returns the export's CSV bytes: gunzipped when they start with the gzip magic, as given otherwise.
 *
 * @example
 * decompressCurExport(gzipSync(csvBytes)); // { ok: true, value: csvBytes }
 */
export function decompressCurExport(bytes: Uint8Array): Result<Uint8Array, StructuredReason> {
  if (bytes[0] !== GZIP_MAGIC[0] || bytes[1] !== GZIP_MAGIC[1]) {
    return ok(bytes);
  }
  try {
    return ok(gunzipSync(bytes, { maxOutputLength: CUR_EXPORT_MAX_BYTES }));
  } catch (error: unknown) {
    // zlib reports every failure as an Error; its string form keeps the class and the message.
    const cause = String(error);
    return err(
      malformed(
        `gzip data cannot be decompressed (${boundedText(cause)}); expected a complete gzip stream of at most ${String(CUR_EXPORT_MAX_BYTES)} bytes`,
      ),
    );
  }
}

function parseRecords(text: string): Result<string[][], StructuredReason> {
  const cursor: ParseCursor = { text, index: 0, record: [], records: [] };
  while (cursor.index < text.length) {
    const failure = readField(cursor);
    if (failure !== undefined) {
      return err(malformed(`record ${String(cursor.records.length + 1)}: ${failure}`));
    }
  }
  return ok(cursor.records);
}

// Reads one field and the separator after it; returns why the text is malformed, or undefined.
function readField(cursor: ParseCursor): string | undefined {
  const quoted = cursor.text.charCodeAt(cursor.index) === QUOTE;
  const field = quoted ? readQuotedField(cursor) : readPlainField(cursor);
  if (typeof field !== 'string') {
    return field.problem;
  }
  cursor.record.push(field);
  return readSeparator(cursor);
}

function readPlainField(cursor: ParseCursor): string | { readonly problem: string } {
  const start = cursor.index;
  while (cursor.index < cursor.text.length && !isSeparator(cursor.text.charCodeAt(cursor.index))) {
    if (cursor.text.charCodeAt(cursor.index) === QUOTE) {
      return {
        problem: `quote inside an unquoted field at character ${String(cursor.index)}; expected the field quoted`,
      };
    }
    cursor.index += 1;
  }
  return cursor.text.slice(start, cursor.index);
}

function readQuotedField(cursor: ParseCursor): string | { readonly problem: string } {
  const opening = cursor.index;
  const parts: string[] = [];
  let start = opening + 1;
  for (;;) {
    const close = cursor.text.indexOf('"', start);
    if (close === -1) {
      return { problem: `quote opened at character ${String(opening)} is never closed; expected a closing quote` };
    }
    parts.push(cursor.text.slice(start, close));
    if (cursor.text.charCodeAt(close + 1) !== QUOTE) {
      cursor.index = close + 1;
      return parts.join('"');
    }
    start = close + 2;
  }
}

// After a field: a comma continues the record, a line end or the end of text closes it.
function readSeparator(cursor: ParseCursor): string | undefined {
  const code = cursor.text.charCodeAt(cursor.index);
  if (Number.isNaN(code)) {
    closeRecord(cursor);
    return undefined;
  }
  if (code === COMMA) {
    cursor.index += 1;
    if (cursor.index === cursor.text.length) {
      closeTrailingEmptyField(cursor);
    }
    return undefined;
  }
  const terminator = lineTerminatorLength(cursor.text, cursor.index);
  if (terminator === 0) {
    return `unexpected ${boundedJsonText(cursor.text.charAt(cursor.index))} at character ${String(cursor.index)}; expected a comma, CRLF or LF after the field`;
  }
  cursor.index += terminator;
  closeRecord(cursor);
  return undefined;
}

// `a,` at the very end of the text ends with an empty last field.
function closeTrailingEmptyField(cursor: ParseCursor): void {
  cursor.record.push('');
  closeRecord(cursor);
}

function closeRecord(cursor: ParseCursor): void {
  cursor.records.push(cursor.record);
  cursor.record = [];
}

function lineTerminatorLength(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === LF) {
    return 1;
  }
  return code === CR && text.charCodeAt(index + 1) === LF ? 2 : 0;
}

function isSeparator(code: number): boolean {
  return code === COMMA || code === LF || code === CR;
}

function tableOf(records: readonly (readonly string[])[]): Result<CurTable, StructuredReason> {
  const [header, ...rows] = records;
  if (header === undefined) {
    return err(malformed('the export is empty; expected a header record of column names'));
  }
  const headerProblem = headerFailure(header);
  if (headerProblem !== undefined) {
    return err(malformed(headerProblem));
  }
  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length) {
      const problem = `record ${String(index + 2)} has ${String(row.length)} field(s); expected ${String(header.length)}, one per header column`;
      return err(malformed(problem));
    }
  }
  return ok({ columns: header, rows });
}

function headerFailure(header: readonly string[]): string | undefined {
  const blank = header.findIndex((name) => name === '');
  if (blank !== -1) {
    return `header column ${String(blank + 1)} is empty; expected a column name`;
  }
  const seen = new Set<string>();
  for (const name of header) {
    if (seen.has(name)) {
      return `header column ${boundedJsonText(name)} appears twice; expected unique column names`;
    }
    seen.add(name);
  }
  return undefined;
}

function malformed(detail: string): StructuredReason {
  return { code: 'CUR_EXPORT_MALFORMED', subject: 'BR-RUA-047', detail };
}
