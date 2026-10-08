// One golden fixture as one committed text file (close-out): the package-relative files of a
// case's evidence in one JSON object, so the repository holds one file per case instead of one
// per evidence file. A UTF-8 file is kept as the list of its lines, so a diff still shows every
// changed line; any other file, such as one a `corrupt_byte` operation broke, as
// `{"base64": "..."}`. The encoding is canonical (members sorted by path, two-space JSON, a final
// newline), so the generator's check compares the committed bytes with the encoding of the
// regeneration, and decoding restores every file's exact bytes.

import { Buffer } from 'node:buffer';

import { boundedJsonText, boundedText, isJsonObject } from '../../../src/record-contract/json-value.ts';
import { decodeUtf8Strict, parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { JsonValue, Result } from '../../../src/record-contract/primitives.ts';
import type { FixtureBytes } from '../../../test/support/golden-builder/digest-links.ts';

type BundleMember = readonly string[] | { readonly base64: string };

const NEWLINE = '\n';
const BASE64 = 'base64';
const encoder = new TextEncoder();

/**
 * The bundle of `files`, in canonical bytes.
 *
 * @example
 * encodeFixtureBundle(new Map([['runner/runner-journal.jsonl', bytes]])); // '{\n  "runner/...": [...]\n}\n' as bytes
 */
export function encodeFixtureBundle(files: FixtureBytes): Uint8Array {
  const members = [...files]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, bytes]): [string, BundleMember] => [path, memberOf(bytes)]);
  return encoder.encode(`${JSON.stringify(Object.fromEntries(members), null, 2)}\n`);
}

/**
 * The files a bundle holds, refused when it is not a JSON object whose every member is a
 * non-empty array of lines without a newline, or `{"base64": <canonical base64>}`.
 *
 * @example
 * decodeFixtureBundle(readFileSync('test/golden/_harness/fixtures/base-probe.fixture.json'));
 */
export function decodeFixtureBundle(bytes: Uint8Array): Result<FixtureBytes, string> {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok) {
    const detail =
      parsed.error.kind === 'invalid_utf8'
        ? `invalid UTF-8 at byte ${String(parsed.error.byte_offset)}`
        : parsed.error.detail;
    return { ok: false, error: `the bundle does not parse (${detail}); expected a JSON object of files` };
  }
  if (!isJsonObject(parsed.value)) {
    return { ok: false, error: `the bundle is ${boundedJsonText(parsed.value)}; expected a JSON object of files` };
  }
  const files = new Map<string, Uint8Array>();
  for (const [path, member] of Object.entries(parsed.value)) {
    const memberBytes = bytesOf(member);
    if (memberBytes === undefined) {
      return {
        ok: false,
        error:
          `member ${boundedText(path)} is ${boundedJsonText(member)}; expected a non-empty array of lines ` +
          `without a newline, or {"base64": <canonical base64>}`,
      };
    }
    files.set(path, memberBytes);
  }
  return { ok: true, value: files };
}

function memberOf(bytes: Uint8Array): BundleMember {
  const text = decodeUtf8Strict(bytes);
  return text.ok ? text.value.split(NEWLINE) : { base64: Buffer.from(bytes).toString(BASE64) };
}

// The bytes of a member, or undefined when it has neither form. Node's base64 decoder skips
// characters outside the alphabet, so only text that its own encoding reproduces is accepted.
function bytesOf(member: JsonValue): Uint8Array | undefined {
  if (Array.isArray(member)) {
    const lines: readonly JsonValue[] = member;
    return isLineList(lines) ? encoder.encode(lines.join(NEWLINE)) : undefined;
  }
  if (!isJsonObject(member) || Object.keys(member).length !== 1 || typeof member[BASE64] !== 'string') {
    return undefined;
  }
  const text = member[BASE64];
  const decoded = Buffer.from(text, BASE64);
  return decoded.toString(BASE64) === text ? new Uint8Array(decoded) : undefined;
}

// Splitting text on newlines yields at least one line and no line that holds a newline.
function isLineList(lines: readonly JsonValue[]): lines is readonly string[] {
  return lines.length > 0 && lines.every((line) => typeof line === 'string' && !line.includes(NEWLINE));
}
