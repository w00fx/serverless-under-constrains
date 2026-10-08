// Reference resolution (design §8.16 step 4; BR-RUA-035) and the RFC 6901 pointer resolver it
// uses: every reference of a derived record names an indexed path with its digest, and its
// event_id and json_pointer resolve; a cross-package reference names a known package index. Both
// walks are iterative and read own members only (A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveJsonPointer } from '../../../src/evidence-package/json-pointer.ts';
import { collectReferences, unresolvedReferenceReasons } from '../../../src/evidence-package/reference-resolution.ts';
import type { ReferenceScope } from '../../../src/evidence-package/reference-resolution.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { IndexEntry } from '../../../src/record-contract/records/group-c/shared-shapes.ts';
import { DEEP_NESTING, parsedJson, towerText } from '../../support/kernel/deep-json.ts';
import { digest, uuid } from '../../support/record-contract/record-builders.ts';
import { textFile } from '../../support/evidence-package/package-files.ts';

const JOURNAL = textFile(
  'probe/journals/caller-journal.jsonl',
  `{"event_id":"${uuid(1)}","outcome":{"status":"ok"}}\n{"n":2}\n`,
);
const LEDGER = textFile('probe/ledger/ledger-snapshot.json', '{"balance":"1.00","rows":[{"a":1}]}\n');
const BROKEN_JSONL = textFile('probe/queues/source-observations.jsonl', '{"n":1}\nnot json\n');
const BAD_JSON = textFile('probe/state/treatment-state-snapshot.json', '{');

function entryOf(file: PackageFile, derivation: 'primary' | 'derived' = 'primary'): IndexEntry {
  return {
    artifact_path: file.path,
    artifact_class: 'payment',
    derivation,
    bytes: file.bytes.length,
    sha256: sha256Hex(file.bytes),
  };
}

function ref(file: PackageFile, extra: Readonly<Record<string, JsonValue>> = {}): JsonValue {
  return { artifact_path: file.path, artifact_sha256: sha256Hex(file.bytes), ...extra };
}

function scopeWith(record: JsonValue, extraFiles: readonly PackageFile[] = []): ReferenceScope {
  const derived = textFile('probe/derived/transport-probe-result.json', JSON.stringify(record));
  const files = [JOURNAL, LEDGER, BROKEN_JSONL, BAD_JSON, derived, ...extraFiles];
  return {
    entries: [...files.map((file) => entryOf(file, file === derived ? 'derived' : 'primary'))],
    files,
    referenced_package_indexes: [digest('probe-package')],
  };
}

function problems(record: JsonValue): readonly string[] {
  return unresolvedReferenceReasons(scopeWith(record), sha256Hex).map((reason) => reason.detail);
}

describe('unresolvedReferenceReasons', () => {
  it('resolves paths, digests, events, pointers and known cross-package references', () => {
    const record = {
      evidence_refs: [
        ref(JOURNAL, { event_id: uuid(1), json_pointer: '/outcome/status' }),
        ref(JOURNAL, { event_id: uuid(1) }),
        ref(LEDGER, { json_pointer: '/rows/0/a' }),
        ref(JOURNAL, { json_pointer: '/1/n' }),
        ref(LEDGER),
        {
          artifact_path: 'elsewhere.json',
          artifact_sha256: digest('x'),
          package_index_sha256: digest('probe-package'),
        },
      ],
      nested: [{ ledger_ref: ref(LEDGER) }],
      oracle_result_refs: [ref(LEDGER)],
      clock_assumption_refs: ['CA-1'],
    };
    assert.deepEqual(problems(record), []);
    assert.equal(collectReferences(record).length, 8);
  });

  it('reports each unresolvable reference with its cause', () => {
    const record = {
      evidence_refs: [
        { artifact_path: 'probe/absent.json', artifact_sha256: digest('a') },
        { artifact_path: LEDGER.path, artifact_sha256: digest('wrong') },
        ref(JOURNAL, { event_id: uuid(9) }),
        ref(LEDGER, { json_pointer: '/missing' }),
        ref(LEDGER, { json_pointer: 7 }),
        ref(BROKEN_JSONL, { json_pointer: '/0' }),
        ref(BAD_JSON, { json_pointer: '' }),
        { artifact_path: 'x.json', artifact_sha256: digest('x'), package_index_sha256: digest('unknown') },
        { artifact_path: 1, artifact_sha256: digest('x') },
        'not a reference',
      ],
      cleanup_result_ref: { artifact_sha256: digest('only') },
    };
    const details = problems(record);
    assert.equal(details.length, 11);
    for (const [index, pattern] of (
      [
        /does not list/,
        /names sha256 .*; the indexed file has/,
        /names an event_id the file does not hold/,
        /json_pointer that resolves to nothing/,
        /json_pointer that resolves to nothing/,
        /JSONL file with an unparseable line/,
        /cannot be read/,
        /unknown package_index_sha256/,
        /no string artifact_path/,
        /no string artifact_path/,
        /no string artifact_path/,
      ] as const
    ).entries()) {
      assert.ok(
        details.some((detail) => pattern.test(detail)),
        `${String(index)}: ${String(pattern)}`,
      );
    }
  });

  it('reports a derived record that is absent or not JSON, and skips derived JSONL', () => {
    const missing = textFile('probe/derived/attempt-projection.json', '{}');
    const scope: ReferenceScope = {
      entries: [entryOf(missing, 'derived'), entryOf(BAD_JSON, 'derived'), entryOf(BROKEN_JSONL, 'derived')],
      files: [BAD_JSON, BROKEN_JSONL],
      referenced_package_indexes: [],
    };
    const reasons = unresolvedReferenceReasons(scope, sha256Hex);
    assert.deepEqual(
      reasons.map((reason) => [reason.code, reason.artifact_path]),
      [
        ['UNRESOLVED_REFERENCE', missing.path],
        ['UNRESOLVED_REFERENCE', BAD_JSON.path],
      ],
    );
  });

  it('reports a reference into a file that is indexed but absent', () => {
    const ghost = textFile('probe/state/trial-registration.json', '{}');
    const scope = scopeWith({ evidence_refs: [ref(ghost, { json_pointer: '' })] });
    const reasons = unresolvedReferenceReasons({ ...scope, entries: [...scope.entries, entryOf(ghost)] }, sha256Hex);
    assert.match(reasons[0]?.detail ?? '', /points into a file that cannot be read/);
  });

  it('reads the event of a JSON document by its own event_id', () => {
    const event = textFile('probe/state/provider-trial-configuration.json', `{"event_id":"${uuid(4)}","v":{"w":1}}`);
    const scope = scopeWith(
      { evidence_refs: [ref(event, { event_id: uuid(4), json_pointer: '/v/w' }), ref(event, { event_id: uuid(5) })] },
      [event],
    );
    assert.deepEqual(
      unresolvedReferenceReasons(scope, sha256Hex).map((reason) =>
        reason.detail.includes('event_id the file does not hold'),
      ),
      [true],
    );
  });

  it('collects references at 100,000 nesting levels without throwing (A-05)', () => {
    const tower = parsedJson(
      towerText(
        'mixed',
        DEEP_NESTING,
        JSON.stringify({ evidence_refs: [{ artifact_path: 'a', artifact_sha256: 'b' }] }),
      ),
    );
    assert.equal(collectReferences(tower).length, 1);
    const wide = { evidence_refs: Array.from({ length: 200_000 }, () => 1) };
    assert.equal(collectReferences(wide).length, 200_000);
  });

  it('reads a single evidence_refs member that is not an array as one reference', () => {
    assert.match(problems({ evidence_refs: 'text' })[0] ?? '', /no string artifact_path/);
    assert.deepEqual(problems({ evidence_refs: ref(LEDGER) }), []);
  });

  it('treats inherited member names as data (A-05)', () => {
    const record = parsedJson('{"__proto__":{"evidence_refs":[1]},"constructor_ref":2}');
    assert.deepEqual(collectReferences(record), [2, 1]);
  });
});

describe('resolveJsonPointer', () => {
  const document = parsedJson('{"a":[{"b":1}],"m~n":{"x/y":2},"":3,"__proto__":{"z":4}}');

  it('resolves RFC 6901 pointers with escapes, array indexes and the empty key', () => {
    assert.deepEqual(resolveJsonPointer(document, ''), { found: true, value: document });
    assert.deepEqual(resolveJsonPointer(document, '/a/0/b'), { found: true, value: 1 });
    assert.deepEqual(resolveJsonPointer(document, '/m~0n/x~1y'), { found: true, value: 2 });
    assert.deepEqual(resolveJsonPointer(document, '/'), { found: true, value: 3 });
    assert.deepEqual(resolveJsonPointer(document, '/__proto__/z'), { found: true, value: 4 });
  });

  it('resolves nothing for malformed pointers, missing members and bad indexes', () => {
    for (const pointer of [
      'a',
      '/a/01',
      '/a/1',
      '/a/-',
      '/a/x',
      '/a/0/b/c',
      '/~2',
      '/constructor',
      '/toString',
      '/missing',
    ]) {
      assert.deepEqual(resolveJsonPointer(document, pointer), { found: false }, pointer);
    }
  });

  it('walks 100,000 levels without recursion (A-05)', () => {
    const tower = parsedJson(towerText('array', DEEP_NESTING, '7'));
    assert.deepEqual(resolveJsonPointer(tower, '/0'.repeat(DEEP_NESTING)), { found: true, value: 7 });
  });
});
