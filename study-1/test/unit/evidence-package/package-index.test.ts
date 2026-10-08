// The final package index (BR-RUA-044; design §7) and the totality of the package record parser
// (AC-RUA-046 feed, Owner amendment A-05): the index hashes every finalized file except itself and
// fails on a file it cannot index; parsing never throws, whatever the bytes, nesting or numbers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPackageIndex, packageIdentity, parsePackageIndex } from '../../../src/evidence-package/package-index.ts';
import { parsePackageRecord } from '../../../src/evidence-package/package-records.ts';
import { compareEntryPaths, duplicatePathReasons, fileAt } from '../../../src/evidence-package/index-entries.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { ExecutionIdentity } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';
import { PROBE_ID, RUN_ID, VALIDATION_ID, at } from '../../support/record-contract/record-builders.ts';
import { reasonCodes, textFile, utf8 } from '../../support/evidence-package/package-files.ts';

const validator = createRecordValidator();
const RUN: ExecutionIdentity = { execution_kind: 'RUN', run_id: RUN_ID };
const MANIFEST = textFile('admission/execution-manifest.json', '{"manifest":1}\n');

describe('buildPackageIndex', () => {
  it('hashes every file except the index itself, sorted by path', () => {
    const files = [
      textFile('summary/run-summary.json', '{"summary":1}\n'),
      MANIFEST,
      textFile('package-index.json', '{"old":true}\n'),
      textFile('coordination/coordination-journal.jsonl', '{"a":1}\n'),
    ];
    const built = buildPackageIndex({ files, identity: RUN, created_at: at(3) });
    assert.ok(built.ok);
    assert.deepEqual(
      built.value.entries.map((entry) => [entry.artifact_path, entry.derivation]),
      [
        ['admission/execution-manifest.json', 'primary'],
        ['coordination/coordination-journal.jsonl', 'primary'],
        ['summary/run-summary.json', 'derived'],
      ],
    );
    assert.equal(built.value.execution_manifest_sha256, sha256Hex(MANIFEST.bytes));
    const reparsed = parsePackageIndex(serializeRecordFile(built.value), validator);
    assert.deepEqual(reparsed, { ok: true, value: built.value });
  });

  it('carries the identity of every execution kind', () => {
    const identities: readonly ExecutionIdentity[] = [
      RUN,
      { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID },
      { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: VALIDATION_ID },
    ];
    assert.deepEqual(identities.map(packageIdentity), [
      { execution_kind: 'RUN', run_id: RUN_ID },
      { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID },
      { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: VALIDATION_ID },
    ]);
  });

  it('fails on invalid or duplicate paths before classifying', () => {
    const built = buildPackageIndex({
      files: [MANIFEST, MANIFEST, textFile('/abs.json', '{}')],
      identity: RUN,
      created_at: at(3),
    });
    assert.ok(!built.ok);
    assert.deepEqual(reasonCodes(built.error), ['DUPLICATE_ARTIFACT_PATH', 'INVALID_ARTIFACT_PATH']);
  });

  it('fails without the execution manifest and on an unclassifiable file', () => {
    const built = buildPackageIndex({ files: [textFile('notes.txt', 'x')], identity: RUN, created_at: at(3) });
    assert.ok(!built.ok);
    assert.deepEqual(reasonCodes(built.error), ['CORE_FILE_MISSING', 'UNCLASSIFIABLE_ARTIFACT_PATH']);
  });

  it('fails on an unclassifiable file even with the manifest present', () => {
    const built = buildPackageIndex({
      files: [MANIFEST, textFile('notes.txt', 'x')],
      identity: RUN,
      created_at: at(3),
    });
    assert.ok(!built.ok);
    assert.deepEqual(reasonCodes(built.error), ['UNCLASSIFIABLE_ARTIFACT_PATH']);
  });
});

describe('parsePackageRecord totality (A-05)', () => {
  it('reports invalid UTF-8 with its byte offset', () => {
    const parsed = parsePackageRecord(
      Uint8Array.of(0x7b, 0xc0, 0x80),
      'package_index',
      validator,
      'package-index.json',
    );
    assert.ok(!parsed.ok);
    assert.equal(parsed.error.code, 'RECORD_UNPARSEABLE');
    assert.match(parsed.error.detail, /invalid UTF-8 at byte 1/);
    assert.equal(parsed.error.artifact_path, 'package-index.json');
  });

  it('reports text that is not JSON', () => {
    const parsed = parsePackageIndex(utf8('{"entries": ['), validator);
    assert.ok(!parsed.ok);
    assert.equal(parsed.error.code, 'RECORD_UNPARSEABLE');
  });

  it('quotes at most three schema violations and counts the rest', () => {
    const parsed = parsePackageIndex(
      utf8('{"record_type":"package_index","schema_version":2,"a":1,"b":2,"c":3,"d":4}'),
      validator,
    );
    assert.ok(!parsed.ok);
    assert.equal(parsed.error.code, 'RECORD_SCHEMA_INVALID');
    assert.match(parsed.error.detail, /and \d+ more; expected a valid package_index/);
  });

  it('rejects 100,000 nesting levels without throwing', () => {
    for (const shape of ['array', 'object', 'mixed'] as const) {
      const parsed = parsePackageIndex(utf8(towerText(shape, DEEP_NESTING, '1')), validator);
      assert.equal(parsed.ok, false, shape);
    }
  });

  it('rejects non-finite numbers without throwing', () => {
    const parsed = parsePackageIndex(utf8('{"schema_version":1e400,"entries":[]}'), validator);
    assert.equal(parsed.ok, false);
  });

  it('rejects inherited member names as data, never as prototype access', () => {
    for (const text of ['{"__proto__":{"record_type":"package_index"}}', '{"constructor":1,"toString":2}']) {
      const parsed = parsePackageIndex(utf8(text), validator);
      assert.ok(!parsed.ok);
      assert.equal(parsed.error.code, 'RECORD_SCHEMA_INVALID');
    }
  });
});

describe('index entry helpers', () => {
  it('reports each duplicated path once', () => {
    const reasons = duplicatePathReasons([MANIFEST, MANIFEST, MANIFEST, textFile('../x', ''), textFile('../x', '')]);
    assert.deepEqual(
      reasons.map((reason) => [reason.code, reason.artifact_path]),
      [
        ['DUPLICATE_ARTIFACT_PATH', MANIFEST.path],
        ['DUPLICATE_ARTIFACT_PATH', undefined],
      ],
    );
  });

  it('orders by UTF-16 code units and finds files by path', () => {
    assert.equal(compareEntryPaths({ artifact_path: 'a' }, { artifact_path: 'a' }), 0);
    assert.equal(compareEntryPaths({ artifact_path: 'B' }, { artifact_path: 'a' }), -1);
    assert.equal(compareEntryPaths({ artifact_path: 'b' }, { artifact_path: 'a' }), 1);
    assert.equal(fileAt([MANIFEST], MANIFEST.path), MANIFEST);
    assert.equal(fileAt([MANIFEST], 'absent'), undefined);
  });
});
