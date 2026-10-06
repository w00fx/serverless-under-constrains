// Total parsers for evidence bytes (BR-RUA-033 UTF-8 JSON and JSONL; AC-RUA-046 fuzz:
// "the JSON, JSONL and package parsers never crash on malformed input"). Every function
// here returns a Result or a report for any byte sequence and never throws.

import { boundedJsonText } from './json-value.ts';
import type { JsonValue, Result } from './primitives.ts';

export interface DecodeFailure {
  readonly kind: 'invalid_utf8';
  readonly byte_offset: number;
}
export type JsonParseFailure = DecodeFailure | { readonly kind: 'invalid_json'; readonly detail: string };

export interface JsonlLine {
  readonly line_number: number;
  readonly parsed: Result<JsonValue, JsonParseFailure>;
}

export interface JsonlParseReport {
  readonly lines: readonly JsonlLine[];
  readonly ends_with_newline: boolean;
  readonly decode_error?: DecodeFailure;
}

const NEWLINE = 0x0a;
// ignoreBOM keeps a leading U+FEFF in the text, so JSON.parse rejects it instead of the
// decoder silently dropping bytes that the file digest still covers.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * Offset of the first byte of the first ill-formed UTF-8 sequence (Unicode 15 Table 3-7),
 * or -1 when every sequence is well formed. Overlongs, surrogates, code points above
 * U+10FFFF and truncated sequences are all ill formed.
 *
 * @example
 * firstInvalidUtf8Offset(Uint8Array.of(0x61, 0xc0, 0x80)); // 1
 */
export function firstInvalidUtf8Offset(bytes: Uint8Array): number {
  let open: OpenSequence | undefined;
  for (const [offset, byte] of bytes.entries()) {
    const next = advanceSequence(open, byte, offset);
    if (next === 'invalid') {
      return open?.start ?? offset;
    }
    open = next;
  }
  return open === undefined ? -1 : open.start;
}

/**
 * Decodes UTF-8 strictly, reporting the byte offset of the first ill-formed sequence.
 *
 * @example
 * const text = decodeUtf8Strict(bytes);
 * if (!text.ok) findings.push(`invalid UTF-8 at byte ${text.error.byte_offset}`);
 */
export function decodeUtf8Strict(bytes: Uint8Array): Result<string, DecodeFailure> {
  const invalidAt = firstInvalidUtf8Offset(bytes);
  if (invalidAt !== -1) {
    return { ok: false, error: { kind: 'invalid_utf8', byte_offset: invalidAt } };
  }
  return { ok: true, value: decoder.decode(bytes) };
}

/**
 * Parses one JSON document from exact file bytes. Numbers that overflow to an infinite
 * double are rejected, so every accepted value can be serialized back canonically. The failure
 * detail quotes the number's JSON pointer bounded: the pointer is built from untrusted member
 * names and nesting, so it can be megabytes long (WP-00 review round 2, A-05 policy 1).
 *
 * @example
 * const parsed = parseJsonDocument(await readFile('oracle-result.json'));
 */
export function parseJsonDocument(bytes: Uint8Array): Result<JsonValue, JsonParseFailure> {
  const text = decodeUtf8Strict(bytes);
  if (!text.ok) {
    return text;
  }
  return parseJsonText(text.value);
}

/**
 * Parses JSONL: every `\n`-separated segment is one line, parsed independently, so one
 * corrupt line never hides the others. A final newline terminates the last line instead of
 * starting an empty one. A decode error offset is relative to the whole file.
 *
 * @example
 * const report = parseJsonl(bytes);
 * const bad = report.lines.filter((line) => !line.parsed.ok);
 */
export function parseJsonl(bytes: Uint8Array): JsonlParseReport {
  const endsWithNewline = bytes.length > 0 && bytes[bytes.length - 1] === NEWLINE;
  const lines = lineSegments(bytes, endsWithNewline).map((segment, index) => ({
    line_number: index + 1,
    parsed: parseLine(segment),
  }));
  const decodeError = lines.map((line) => line.parsed).find(isDecodeFailure);
  const report = { lines, ends_with_newline: endsWithNewline };
  return decodeError === undefined ? report : { ...report, decode_error: decodeError.error };
}

interface LineSegment {
  readonly start: number;
  readonly bytes: Uint8Array;
}

function lineSegments(bytes: Uint8Array, endsWithNewline: boolean): readonly LineSegment[] {
  const segments: LineSegment[] = [];
  const limit = endsWithNewline ? bytes.length - 1 : bytes.length;
  let start = 0;
  for (let index = bytes.indexOf(NEWLINE); index !== -1 && index < limit; index = bytes.indexOf(NEWLINE, start)) {
    segments.push({ start, bytes: bytes.subarray(start, index) });
    start = index + 1;
  }
  if (bytes.length > 0) {
    segments.push({ start, bytes: bytes.subarray(start, limit) });
  }
  return segments;
}

function parseLine(segment: LineSegment): Result<JsonValue, JsonParseFailure> {
  const parsed = parseJsonDocument(segment.bytes);
  if (parsed.ok || parsed.error.kind === 'invalid_json') {
    return parsed;
  }
  return { ok: false, error: { kind: 'invalid_utf8', byte_offset: segment.start + parsed.error.byte_offset } };
}

function isDecodeFailure(
  parsed: Result<JsonValue, JsonParseFailure>,
): parsed is { readonly ok: false; readonly error: DecodeFailure } {
  return !parsed.ok && parsed.error.kind === 'invalid_utf8';
}

function parseJsonText(text: string): Result<JsonValue, JsonParseFailure> {
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch (error: unknown) {
    return { ok: false, error: { kind: 'invalid_json', detail: (error as Error).message } };
  }
  const overflowAt = findNonFiniteNumber(value);
  if (overflowAt !== undefined) {
    return {
      ok: false,
      error: {
        kind: 'invalid_json',
        detail: `number at JSON pointer ${boundedJsonText(overflowAt)} overflows a finite double`,
      },
    };
  }
  return { ok: true, value };
}

// Iterative on purpose: JSON.parse accepts nesting deeper than the call stack allows.
function findNonFiniteNumber(root: JsonValue): string | undefined {
  const pending: { readonly value: JsonValue; readonly pointer: string }[] = [{ value: root, pointer: '' }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next.value === 'number' && !Number.isFinite(next.value)) {
      return next.pointer;
    }
    if (typeof next.value === 'object' && next.value !== null) {
      pushChildren(pending, next.value, next.pointer);
    }
  }
  return undefined;
}

function pushChildren(
  pending: { readonly value: JsonValue; readonly pointer: string }[],
  container: readonly JsonValue[] | Readonly<Record<string, JsonValue>>,
  pointer: string,
): void {
  for (const [key, value] of Object.entries(container)) {
    pending.push({ value, pointer: `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}` });
  }
}

// A multi-byte sequence whose lead byte has been read but whose continuations have not all arrived.
interface OpenSequence {
  readonly shape: SequenceShape;
  readonly start: number;
  readonly consumed: number;
}

// Feeds one byte: returns the sequence still open after it, undefined when none is open, or
// 'invalid' when the byte cannot continue (or start) a well-formed sequence.
function advanceSequence(
  open: OpenSequence | undefined,
  byte: number,
  offset: number,
): OpenSequence | undefined | 'invalid' {
  if (open === undefined) {
    return startSequence(byte, offset);
  }
  const second = open.consumed === 1;
  const min = second ? open.shape.secondMin : 0x80;
  const max = second ? open.shape.secondMax : 0xbf;
  if (byte < min || byte > max) {
    return 'invalid';
  }
  const consumed = open.consumed + 1;
  return consumed === open.shape.length ? undefined : { ...open, consumed };
}

function startSequence(byte: number, offset: number): OpenSequence | undefined | 'invalid' {
  if (byte <= 0x7f) {
    return undefined;
  }
  const shape = sequenceShape(byte);
  return shape === undefined ? 'invalid' : { shape, start: offset, consumed: 1 };
}

interface SequenceShape {
  readonly length: number;
  readonly secondMin: number;
  readonly secondMax: number;
}

function sequenceShape(lead: number): SequenceShape | undefined {
  if (lead >= 0xc2 && lead <= 0xdf) {
    return { length: 2, secondMin: 0x80, secondMax: 0xbf };
  }
  if (lead >= 0xe0 && lead <= 0xef) {
    return threeByteShape(lead);
  }
  if (lead >= 0xf0 && lead <= 0xf4) {
    return fourByteShape(lead);
  }
  return undefined;
}

function threeByteShape(lead: number): SequenceShape {
  if (lead === 0xe0) {
    return { length: 3, secondMin: 0xa0, secondMax: 0xbf };
  }
  if (lead === 0xed) {
    return { length: 3, secondMin: 0x80, secondMax: 0x9f };
  }
  return { length: 3, secondMin: 0x80, secondMax: 0xbf };
}

function fourByteShape(lead: number): SequenceShape {
  if (lead === 0xf0) {
    return { length: 4, secondMin: 0x90, secondMax: 0xbf };
  }
  if (lead === 0xf4) {
    return { length: 4, secondMin: 0x80, secondMax: 0x8f };
  }
  return { length: 4, secondMin: 0x80, secondMax: 0xbf };
}
