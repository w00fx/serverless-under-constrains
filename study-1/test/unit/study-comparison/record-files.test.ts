// Reading frozen record files and journals (A-05): every outcome over untrusted bytes is a value,
// never a throw. A record keeps a reference to the exact bytes it was read from.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { bytesRef, readJournalRecords, readRecordFile } from '../../../src/study-comparison/record-files.ts';
import type { FixtureBytes } from '../../support/golden-builder/digest-links.ts';
import { READ_DEPS, cleanRunFiles, editJson, editJsonl, withBytes, withoutFile } from './support/clean-run.ts';

const encoder = new TextEncoder();
let files: FixtureBytes;

before(async () => {
  files = await cleanRunFiles();
});

function reasonOf(read: ReturnType<typeof readRecordFile>): string {
  assert.equal(read.status, 'unreadable');
  return `${read.reason.code} ${read.reason.artifact_path ?? ''} ${read.reason.detail}`;
}

describe('readRecordFile', () => {
  it('reads a valid record with a reference to its exact bytes', () => {
    const path = EXECUTION_PATHS.cleanupResult;
    const read = readRecordFile(files, path, 'cleanup_result', READ_DEPS);
    assert.equal(read.status, 'read');
    assert.equal(read.frozen.record.cleanup_status, 'succeeded');
    assert.deepEqual(read.frozen.ref, {
      artifact_path: path,
      artifact_sha256: sha256Hex(files.get(path) ?? new Uint8Array()),
    });
  });

  it('is absent when no file is stored', () => {
    const path = EXECUTION_PATHS.cleanupResult;
    assert.deepEqual(readRecordFile(withoutFile(files, path), path, 'cleanup_result', READ_DEPS), { status: 'absent' });
  });

  it('reports invalid UTF-8 with its byte offset', () => {
    const path = EXECUTION_PATHS.cleanupResult;
    const read = readRecordFile(
      withBytes(files, path, new Uint8Array([0x7b, 0xff])),
      path,
      'cleanup_result',
      READ_DEPS,
    );
    assert.match(
      reasonOf(read),
      /^ARTIFACT_UNREADABLE cleanup\/cleanup-result\.json .*invalid UTF-8 at byte 1; expected one UTF-8 JSON cleanup_result document$/,
    );
  });

  it('reports text that is not JSON', () => {
    const path = EXECUTION_PATHS.cleanupResult;
    const read = readRecordFile(withBytes(files, path, encoder.encode('{"a":')), path, 'cleanup_result', READ_DEPS);
    assert.match(reasonOf(read), /expected one UTF-8 JSON cleanup_result document$/);
  });

  it('reports a JSON value that is not a valid record of the type, with the first violation', () => {
    const path = EXECUTION_PATHS.cleanupResult;
    const edited = editJson(files, path, (record) => ({ ...record, cleanup_status: 'gone' }));
    const read = readRecordFile(edited, path, 'cleanup_result', READ_DEPS);
    assert.match(
      reasonOf(read),
      /\d+ schema violation\(s\), first \w+ at "[^"]*": .*; expected a valid cleanup_result$/,
    );
  });

  it('reads a non-finite number as unreadable, never as a value', () => {
    const path = EXECUTION_PATHS.cleanupResult;
    const text = new TextDecoder().decode(files.get(path)).replace('"schema_version":1', '"schema_version":1e400');
    const read = readRecordFile(withBytes(files, path, encoder.encode(text)), path, 'cleanup_result', READ_DEPS);
    assert.equal(read.status, 'unreadable');
  });
});

describe('bytesRef', () => {
  it('references stored bytes by digest and is undefined for an absent file', () => {
    const path = EXECUTION_PATHS.executionManifest;
    assert.deepEqual(bytesRef(files, path, sha256Hex), {
      artifact_path: path,
      artifact_sha256: sha256Hex(files.get(path) ?? new Uint8Array()),
    });
    assert.equal(bytesRef(files, 'nowhere.json', sha256Hex), undefined);
  });
});

describe('readJournalRecords', () => {
  const path = EXECUTION_PATHS.runnerJournal;

  it('reads the requested types in file order and skips the others unread', () => {
    const read = readJournalRecords(files, path, ['phase_transition_recorded'], READ_DEPS);
    assert.deepEqual(read.reasons, []);
    assert.ok(read.records.length > 0);
    const occurred = read.records.map((record) => record.occurred_at);
    assert.deepEqual(occurred, occurred.toSorted());
  });

  it('reads an absent journal as empty', () => {
    assert.deepEqual(readJournalRecords(withoutFile(files, path), path, ['trial_interrupted'], READ_DEPS), {
      records: [],
      reasons: [],
    });
  });

  it('reports a line that is not JSON and keeps reading', () => {
    const text = `not json\n${new TextDecoder().decode(files.get(path))}`;
    const read = readJournalRecords(
      withBytes(files, path, encoder.encode(text)),
      path,
      ['phase_transition_recorded'],
      READ_DEPS,
    );
    assert.equal(read.reasons.length, 1);
    assert.match(read.reasons[0]?.detail ?? '', /runner-journal\.jsonl line 1: .*; expected one JSON record per line$/);
    assert.ok(read.records.length > 0);
  });

  it('reports a requested-type line that is not a valid record of it', () => {
    const edited = editJsonl(files, path, (lines) => [
      { ...lines[0], record_type: 'trial_interrupted' },
      ...lines.slice(1),
    ]);
    const read = readJournalRecords(edited, path, ['trial_interrupted'], READ_DEPS);
    assert.equal(read.records.length, 0);
    assert.equal(read.reasons.length, 1);
    assert.match(
      read.reasons[0]?.detail ?? '',
      /line 1: \d+ schema violation\(s\).*expected a valid trial_interrupted$/,
    );
  });

  it('skips lines that are not objects or declare no own record_type (inherited names are not members)', () => {
    const extra = [
      '[1]',
      '"text"',
      '{}',
      '{"__proto__":{"record_type":"phase_transition_recorded"}}',
      '{"constructor":1}',
    ];
    const text = `${extra.join('\n')}\n${new TextDecoder().decode(files.get(path))}`;
    const read = readJournalRecords(
      withBytes(files, path, encoder.encode(text)),
      path,
      ['phase_transition_recorded'],
      READ_DEPS,
    );
    assert.deepEqual(read.reasons, []);
    assert.equal(
      read.records.length,
      readJournalRecords(files, path, ['phase_transition_recorded'], READ_DEPS).records.length,
    );
  });

  it('does not treat a record_type naming an Object.prototype member as requested', () => {
    const line = canonicalJson({ record_type: 'toString' });
    const read = readJournalRecords(
      withBytes(files, path, encoder.encode(`${line}\n`)),
      path,
      ['phase_transition_recorded'],
      READ_DEPS,
    );
    assert.deepEqual(read, { records: [], reasons: [] });
  });
});
