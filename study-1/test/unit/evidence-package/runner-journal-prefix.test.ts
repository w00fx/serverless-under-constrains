// Runner-journal prefix references (CMP-05 R1; Owner amendment A-15, decision 80; BR-RUA-044
// prefix model; design §8.16 step 4). The runner journal stays open after every freeze, so a
// frozen derived record cites it with the digest of a newline-terminated prefix of the final
// journal. Such a reference resolves, and its event_id / json_pointer resolve inside that prefix
// only. No other path gains prefix resolution.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LinePrefixDigests } from '../../../src/evidence-package/line-prefix-digests.ts';
import type { ByteDigest } from '../../../src/evidence-package/package-integrity.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { unresolvedReferenceReasons } from '../../../src/evidence-package/reference-resolution.ts';
import type { ReferenceScope } from '../../../src/evidence-package/reference-resolution.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { boundedJsonText } from '../../../src/record-contract/json-value.ts';
import type { JsonValue, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { IndexEntry } from '../../../src/record-contract/records/group-c/shared-shapes.ts';
import { uuid } from '../../support/record-contract/record-builders.ts';
import { textFile, utf8 } from '../../support/evidence-package/package-files.ts';

const RESULT_PATH = 'trials/00000000-0000-4000-8000-000000000101/derived/oracle-result.json';
const LINE_1 = `{"event_id":"${uuid(1)}","phase":"TRIALS","detail":{"status":"started"}}\n`;
const LINE_2 = `{"event_id":"${uuid(2)}","phase":"TRIALS","detail":{"status":"succeeded"}}\n`;
const LINE_3 = `{"event_id":"${uuid(3)}","phase":"CLEANUP","detail":{"status":"started"}}\n`;
const RUNNER = textFile(EXECUTION_PATHS.runnerJournal, LINE_1 + LINE_2 + LINE_3);
const FROZEN_PREFIX = LINE_1 + LINE_2;
const OTHER_JSONL = textFile(EXECUTION_PATHS.coordinationJournal, LINE_1 + LINE_2 + LINE_3);

function entryOf(file: PackageFile, derivation: 'primary' | 'derived' = 'primary'): IndexEntry {
  return {
    artifact_path: file.path,
    artifact_class: 'payment',
    derivation,
    bytes: file.bytes.length,
    sha256: sha256Hex(file.bytes),
  };
}

function textDigest(text: string): Sha256Hex {
  return sha256Hex(utf8(text));
}

function prefixRef(path: string, prefix: string, extra: Readonly<Record<string, JsonValue>> = {}): JsonValue {
  return { artifact_path: path, artifact_sha256: textDigest(prefix), ...extra };
}

function scopeOf(
  references: readonly JsonValue[],
  journals: readonly PackageFile[] = [RUNNER, OTHER_JSONL],
): ReferenceScope {
  const result = textFile(RESULT_PATH, JSON.stringify({ evidence_refs: references }));
  return {
    entries: [...journals.map((file) => entryOf(file)), entryOf(result, 'derived')],
    files: [...journals, result],
    referenced_package_indexes: [],
  };
}

function details(references: readonly JsonValue[], journals?: readonly PackageFile[]): readonly string[] {
  return unresolvedReferenceReasons(scopeOf(references, journals), sha256Hex).map((reason) => reason.detail);
}

function expectedDetail(reference: JsonValue, problem: string): string {
  // The verifier bounds the reference text it quotes (long references end in an ellipsis).
  return `"${RESULT_PATH}": reference ${boundedJsonText(reference)} ${problem}`;
}

function digestMismatch(reference: JsonValue, indexed: PackageFile): string {
  const cited = (reference as { readonly artifact_sha256: string }).artifact_sha256;
  return expectedDetail(reference, `names sha256 ${cited}; the indexed file has ${sha256Hex(indexed.bytes)}`);
}

describe('A-15 a runner-journal reference resolves by a line-boundary prefix', () => {
  it('resolves the digest of every line-boundary prefix and of the whole journal', () => {
    const references = [LINE_1, FROZEN_PREFIX, LINE_1 + LINE_2 + LINE_3].map((prefix) =>
      prefixRef(RUNNER.path, prefix),
    );
    assert.deepEqual(details(references), []);
  });

  it('resolves the full-file digest of a journal without a final newline', () => {
    const open = textFile(RUNNER.path, `${FROZEN_PREFIX}{"event_id":"${uuid(3)}"`);
    const whole = { artifact_path: open.path, artifact_sha256: sha256Hex(open.bytes) };
    assert.deepEqual(details([whole, prefixRef(open.path, FROZEN_PREFIX)], [open]), []);
  });

  it('reports the digest of a prefix that does not end at a line boundary', () => {
    const cut = prefixRef(RUNNER.path, FROZEN_PREFIX.slice(0, -1));
    const intoLine = prefixRef(RUNNER.path, `${FROZEN_PREFIX}{`);
    assert.deepEqual(details([cut, intoLine]), [digestMismatch(cut, RUNNER), digestMismatch(intoLine, RUNNER)]);
  });

  it('reports the digest of the empty prefix: zero bytes end no line', () => {
    const empty = prefixRef(RUNNER.path, '');
    assert.deepEqual(details([empty]), [digestMismatch(empty, RUNNER)]);
  });

  it('resolves an empty journal only by its own (full-file) digest', () => {
    const emptyJournal = textFile(RUNNER.path, '');
    assert.deepEqual(details([prefixRef(RUNNER.path, '')], [emptyJournal]), []);
  });

  it('resolves an event_id inside the prefix and refuses one appended after it', () => {
    const inside = prefixRef(RUNNER.path, FROZEN_PREFIX, { event_id: uuid(2) });
    const after = prefixRef(RUNNER.path, FROZEN_PREFIX, { event_id: uuid(3) });
    assert.deepEqual(details([inside, after]), [expectedDetail(after, 'names an event_id the file does not hold')]);
  });

  it('resolves a json_pointer inside the prefix event and refuses one into a later line', () => {
    const inEvent = prefixRef(RUNNER.path, FROZEN_PREFIX, { event_id: uuid(1), json_pointer: '/detail/status' });
    const missing = prefixRef(RUNNER.path, FROZEN_PREFIX, { event_id: uuid(1), json_pointer: '/detail/absent' });
    const lineInside = prefixRef(RUNNER.path, FROZEN_PREFIX, { json_pointer: '/1/phase' });
    const lineAfter = prefixRef(RUNNER.path, FROZEN_PREFIX, { json_pointer: '/2/phase' });
    assert.deepEqual(details([inEvent, missing, lineInside, lineAfter]), [
      expectedDetail(
        missing,
        'has a json_pointer that resolves to nothing; expected an RFC 6901 pointer to an existing value',
      ),
      expectedDetail(
        lineAfter,
        'has a json_pointer that resolves to nothing; expected an RFC 6901 pointer to an existing value',
      ),
    ]);
  });

  it('reports a prefix with an unparseable line when a json_pointer addresses its lines', () => {
    const broken = textFile(RUNNER.path, `${LINE_1}not json\n${LINE_3}`);
    const reference = prefixRef(RUNNER.path, `${LINE_1}not json\n`, { json_pointer: '/0' });
    assert.deepEqual(details([reference], [broken]), [
      expectedDetail(reference, 'points into a JSONL file with an unparseable line'),
    ]);
  });

  it('gives no other path prefix resolution, the coordination journal included', () => {
    const coordination = prefixRef(OTHER_JSONL.path, FROZEN_PREFIX);
    const otherJournal = textFile('probe/journals/caller-journal.jsonl', LINE_1 + LINE_2 + LINE_3);
    const caller = prefixRef(otherJournal.path, FROZEN_PREFIX);
    assert.deepEqual(details([coordination, caller], [RUNNER, OTHER_JSONL, otherJournal]), [
      digestMismatch(coordination, OTHER_JSONL),
      digestMismatch(caller, otherJournal),
    ]);
  });

  it('resolves no prefix of stored bytes that are not the indexed bytes', () => {
    const scope = scopeOf([prefixRef(RUNNER.path, FROZEN_PREFIX)]);
    const altered = textFile(RUNNER.path, `${LINE_1}${LINE_2}{"event_id":"${uuid(9)}"}\n`);
    const files = scope.files.map((file) => (file.path === RUNNER.path ? altered : file));
    const reasons = unresolvedReferenceReasons({ ...scope, files }, sha256Hex);
    assert.deepEqual(
      reasons.map((reason) => reason.detail),
      [digestMismatch(prefixRef(RUNNER.path, FROZEN_PREFIX), RUNNER)],
    );
  });

  it('reports a runner-journal reference when the indexed journal is not stored', () => {
    const scope = scopeOf([prefixRef(RUNNER.path, FROZEN_PREFIX)]);
    const files = scope.files.filter((file) => file.path !== RUNNER.path);
    const reasons = unresolvedReferenceReasons({ ...scope, files }, sha256Hex);
    assert.deepEqual(
      reasons.map((reason) => reason.code),
      ['UNRESOLVED_REFERENCE'],
    );
  });

  it('digests the journal prefixes once per verification, through the injected digest', () => {
    const calls: number[] = [];
    const counting: ByteDigest = (bytes) => {
      calls.push(bytes.length);
      return sha256Hex(bytes);
    };
    const references = [
      prefixRef(RUNNER.path, LINE_1),
      prefixRef(RUNNER.path, FROZEN_PREFIX),
      prefixRef(RUNNER.path, LINE_1, { event_id: uuid(1) }),
      prefixRef(RUNNER.path, 'never a prefix\n'),
      prefixRef(RUNNER.path, 'nor this\n'),
    ];
    const reasons = unresolvedReferenceReasons(scopeOf(references), counting);
    assert.equal(reasons.length, 2);
    const lineEnds = [LINE_1, FROZEN_PREFIX, LINE_1 + LINE_2 + LINE_3].map((text) => utf8(text).length);
    // One digest of the stored journal (is it the indexed one?), then each line-boundary prefix once.
    assert.deepEqual(calls, [RUNNER.bytes.length, ...lineEnds]);
  });
});

describe('LinePrefixDigests', () => {
  it('maps each newline-terminated prefix digest to its byte length, and nothing else', () => {
    const prefixes = new LinePrefixDigests(utf8('a\nbc\n\nd'), sha256Hex);
    assert.deepEqual(prefixes.prefixWithDigest(textDigest('a\nbc\n')), utf8('a\nbc\n'));
    assert.equal(prefixes.prefixWithDigest(textDigest('a\n'))?.length, 2);
    assert.equal(prefixes.prefixWithDigest(textDigest('a\nbc\n\n'))?.length, 6);
    for (const text of ['', 'a', 'a\nb', 'a\nbc\n\nd', 'x\n']) {
      assert.equal(prefixes.prefixWithDigest(textDigest(text))?.length, undefined, JSON.stringify(text));
    }
  });

  it('finds nothing in bytes without a newline, the empty bytes included', () => {
    assert.equal(
      new LinePrefixDigests(utf8('{"no":"newline"}'), sha256Hex).prefixWithDigest(textDigest('')),
      undefined,
    );
    assert.equal(new LinePrefixDigests(new Uint8Array(), sha256Hex).prefixWithDigest(textDigest('')), undefined);
  });

  it('digests nothing for a huge journal without a newline (A-05)', () => {
    const calls: number[] = [];
    const prefixes = new LinePrefixDigests(new Uint8Array(8 * 1024 * 1024).fill(0x7b), (bytes) => {
      calls.push(bytes.length);
      return sha256Hex(bytes);
    });
    assert.equal(prefixes.prefixWithDigest(textDigest('{')), undefined);
    assert.deepEqual(calls, []);
  });

  it('digests each prefix of a newline-only journal once however many lookups fail', () => {
    const calls: number[] = [];
    const prefixes = new LinePrefixDigests(new Uint8Array(1_000).fill(0x0a), (bytes) => {
      calls.push(bytes.length);
      return sha256Hex(bytes);
    });
    assert.equal(prefixes.prefixWithDigest(textDigest('absent'))?.length, undefined);
    assert.equal(prefixes.prefixWithDigest(textDigest('\n'.repeat(500)))?.length, 500);
    assert.equal(prefixes.prefixWithDigest(textDigest('still absent'))?.length, undefined);
    assert.equal(calls.length, 1_000);
  });
});
