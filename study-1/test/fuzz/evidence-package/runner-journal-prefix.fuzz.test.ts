// Runner-journal prefix references over random journals (CMP-05 R1; Owner amendment A-15,
// decision 80; testing rule 6; A-05). For any journal, the digest of every newline-terminated
// prefix resolves; the digest of any other cut, and any random digest, does not; an event_id
// resolves only when its line is inside the cited prefix; and hostile journal bytes and hostile
// references never make the resolution throw.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { unresolvedReferenceReasons } from '../../../src/evidence-package/reference-resolution.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const encoder = new TextEncoder();
const NEWLINE = 0x0a;
const RESULT_PATH = 'probe/derived/transport-probe-result.json';
const RUNNER = EXECUTION_PATHS.runnerJournal;

function reasonsFor(journal: Uint8Array, references: readonly JsonValue[]): readonly string[] {
  const result: PackageFile = {
    path: RESULT_PATH,
    bytes: encoder.encode(JSON.stringify({ evidence_refs: references })),
  };
  const files: readonly PackageFile[] = [{ path: RUNNER, bytes: journal }, result];
  return unresolvedReferenceReasons(
    {
      entries: files.map((file) => ({
        artifact_path: file.path,
        artifact_class: 'transport_probe_result',
        derivation: file.path === RESULT_PATH ? 'derived' : 'primary',
        bytes: file.bytes.length,
        sha256: sha256Hex(file.bytes),
      })),
      files,
      referenced_package_indexes: [],
    },
    sha256Hex,
  ).map((reason) => reason.detail);
}

function cutRef(journal: Uint8Array, length: number, extra: Readonly<Record<string, JsonValue>> = {}): JsonValue {
  return { artifact_path: RUNNER, artifact_sha256: sha256Hex(journal.subarray(0, length)), ...extra };
}

function lineEnds(journal: Uint8Array): readonly number[] {
  return [...journal.keys()].filter((index) => journal[index] === NEWLINE).map((index) => index + 1);
}

// Journal text: lines of arbitrary text without a newline, joined, with or without a final newline
// (an open journal can end in a line still being appended).
const journalText = fc
  .tuple(
    fc.array(
      fc.string({ unit: 'grapheme', maxLength: 12 }).map((line) => line.replaceAll('\n', ' ')),
      { maxLength: 8 },
    ),
    fc.boolean(),
  )
  .map(([lines, terminated]) => lines.join('\n') + (terminated && lines.length > 0 ? '\n' : ''));

// Hostile bytes: arbitrary bytes, or bytes drawn from newlines and JSON punctuation so that line
// boundaries and almost-JSON lines are common.
const hostileJournal = fc.oneof(
  fc.uint8Array({ maxLength: 64 }),
  fc
    .array(fc.constantFrom(0x0a, 0x0d, 0x7b, 0x7d, 0x22, 0x3a, 0x30, 0xff, 0xc3), { maxLength: 64 })
    .map((bytes) => Uint8Array.from(bytes)),
);

describe('A-15 runner-journal prefix references (property)', () => {
  it('resolves the digest of every line-boundary prefix of any journal', () => {
    fc.assert(
      fc.property(journalText, (text) => {
        const journal = encoder.encode(text);
        const references = [...lineEnds(journal), journal.length].map((end) => cutRef(journal, end));
        assert.deepEqual(reasonsFor(journal, references), []);
      }),
      fuzzParameters(),
    );
  });

  it('refuses the digest of any cut that is not a line boundary, the empty cut included', () => {
    fc.assert(
      fc.property(journalText, fc.nat(), (text, seed) => {
        const journal = encoder.encode(text);
        const ends = new Set([...lineEnds(journal), journal.length]);
        const cut = seed % (journal.length + 1);
        fc.pre(!ends.has(cut));
        assert.equal(reasonsFor(journal, [cutRef(journal, cut)]).length, 1);
      }),
      fuzzParameters(),
    );
  });

  it('refuses random digests', () => {
    fc.assert(
      fc.property(journalText, fc.stringMatching(/^[0-9a-f]{64}$/), (text, randomDigest) => {
        const journal = encoder.encode(text);
        const prefixDigests = new Set<string>(
          [0, ...lineEnds(journal), journal.length].map((end) => sha256Hex(journal.subarray(0, end))),
        );
        fc.pre(!prefixDigests.has(randomDigest));
        const details = reasonsFor(journal, [{ artifact_path: RUNNER, artifact_sha256: randomDigest }]);
        assert.equal(details.length, 1);
        assert.equal(
          details[0],
          `"${RESULT_PATH}": reference {"artifact_path":"${RUNNER}","artifact_sha256":"${randomDigest}"} names sha256 ${randomDigest}; the indexed file has ${sha256Hex(journal)}; expected that digest or the digest of a line-boundary prefix of the indexed journal (A-15)`,
        );
      }),
      fuzzParameters(),
    );
  });

  it('resolves an event_id only when its line is inside the cited prefix', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.nat(), fc.nat(), (count, prefixSeed, eventSeed) => {
        const ids = Array.from({ length: count }, (_, index) => `e-${String(index)}`);
        const journal = encoder.encode(ids.map((id) => `${JSON.stringify({ event_id: id })}\n`).join(''));
        const ends = lineEnds(journal);
        const lines = (prefixSeed % count) + 1;
        const event = eventSeed % count;
        const details = reasonsFor(journal, [cutRef(journal, ends[lines - 1] ?? 0, { event_id: ids[event] ?? '' })]);
        assert.equal(details.length, event < lines ? 0 : 1);
      }),
      fuzzParameters(),
    );
  });

  it('never throws on hostile journal bytes and hostile references (A-05)', () => {
    fc.assert(
      fc.property(
        hostileJournal,
        fc.array(fc.nat(), { maxLength: 4 }),
        fc.jsonValue({ maxDepth: 2 }),
        (journal, cuts, extraValue) => {
          const extra = extraValue as JsonValue;
          const ends = [0, ...lineEnds(journal), journal.length];
          const located = { event_id: extra, json_pointer: extra };
          const references = [
            ...cuts.map((cut) => cutRef(journal, cut % (journal.length + 1), located)),
            ...cuts.map((cut) => cutRef(journal, ends[cut % ends.length] ?? 0, located)),
            extra,
          ];
          for (const detail of reasonsFor(journal, references)) {
            assert.ok(detail.startsWith(`"${RESULT_PATH}": `), detail);
          }
        },
      ),
      fuzzParameters(),
    );
  });
});
