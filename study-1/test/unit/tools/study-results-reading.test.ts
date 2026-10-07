// Reading evidence packages for the derived Study 1 results (close-out Phase 1): every file is
// checked against its index, and every malformed member stops the derivation with its reason.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ArtifactRef } from '../../../tools/lib/study-results-reading.ts';
import {
  booleanOf,
  byArtifactPath,
  holdsFile,
  integerOf,
  loadPackage,
  memberOf,
  objectOf,
  objectsOf,
  parseRecord,
  readLines,
  readRecord,
  stringOf,
} from '../../../tools/lib/study-results-reading.ts';
import { bytesOf, digestOf, InMemoryEvidence } from './support/in-memory-evidence.ts';

const DIRECTORY = 'runs/r';

function evidenceWith(files: Record<string, string>): InMemoryEvidence {
  const evidence = new InMemoryEvidence();
  evidence.putPackage(DIRECTORY, new Map(Object.entries(files)));
  return evidence;
}

describe('loadPackage', () => {
  it('reads every indexed file and identifies the package by the digest of its index bytes', () => {
    const evidence = evidenceWith({ 'a.json': '{"x":1}', 'b.jsonl': '{"y":2}' });
    const pkg = loadPackage(DIRECTORY, evidence.read);
    assert.equal(pkg.directory, DIRECTORY);
    assert.equal(pkg.index_sha256, evidence.indexDigest(DIRECTORY));
    assert.deepEqual([...pkg.files.keys()], ['a.json', 'b.jsonl']);
    assert.deepEqual(pkg.files.get('a.json'), {
      path: 'a.json',
      sha256: digestOf('{"x":1}'),
      bytes: bytesOf('{"x":1}'),
    });
  });

  it('refuses a file whose digest or byte count differs from its index entry', () => {
    const evidence = evidenceWith({ 'a.json': '{"x":1}' });
    evidence.put(`${DIRECTORY}/a.json`, '{"x":2}');
    assert.throws(() => loadPackage(DIRECTORY, evidence.read), {
      message: `${DIRECTORY}/a.json is 7 bytes with SHA-256 ${digestOf('{"x":2}')}; expected the indexed 7 bytes with SHA-256 ${digestOf('{"x":1}')}`,
    });
    const sameDigest = new InMemoryEvidence();
    sameDigest.put(`${DIRECTORY}/a.json`, '{"x":1}');
    sameDigest.put(`${DIRECTORY}/package-index.json`, {
      entries: [{ artifact_path: 'a.json', bytes: 8, sha256: digestOf('{"x":1}') }],
    });
    assert.throws(() => loadPackage(DIRECTORY, sameDigest.read), /is 7 bytes .*expected the indexed 8 bytes/);
  });

  it('refuses an index that is not an object of entries', () => {
    const evidence = new InMemoryEvidence();
    evidence.put(`${DIRECTORY}/package-index.json`, []);
    assert.throws(() => loadPackage(DIRECTORY, evidence.read), {
      message: `${DIRECTORY}/package-index.json holds array []; expected one JSON object`,
    });
    evidence.put(`${DIRECTORY}/package-index.json`, { entries: [{ artifact_path: 'a.json', sha256: 'x' }] });
    assert.throws(() => loadPackage(DIRECTORY, evidence.read), {
      message: `${DIRECTORY}/package-index.json entry: bytes is absent; expected a safe integer`,
    });
  });
});

describe('reading package files', () => {
  const pkg = loadPackage(
    DIRECTORY,
    evidenceWith({
      'ok.json': '{"x":1}',
      'list.json': '[1]',
      'bad.json': '{',
      'lines.jsonl': '{"a":1}\n{"b":2}',
      'mixed.jsonl': '{"a":1}\n[2]',
    }).read,
  );

  it('reads one object with the reference that cites it', () => {
    assert.deepEqual(readRecord(pkg, 'ok.json'), {
      record: { x: 1 },
      ref: { package_index_sha256: pkg.index_sha256, artifact_path: 'ok.json', artifact_sha256: digestOf('{"x":1}') },
    });
    assert.equal(holdsFile(pkg, 'ok.json'), true);
    assert.equal(holdsFile(pkg, 'absent.json'), false);
  });

  it('refuses a file the index does not hold, a non-object and unparsable bytes', () => {
    assert.throws(() => readRecord(pkg, 'absent.json'), {
      message: `${DIRECTORY} indexes no "absent.json"; expected the package to hold it`,
    });
    assert.throws(() => readRecord(pkg, 'list.json'), {
      message: `${DIRECTORY}/list.json holds array [1]; expected one JSON object`,
    });
    assert.throws(
      () => readRecord(pkg, 'bad.json'),
      /^Error: runs\/r\/bad\.json holds \{.*\}; expected one JSON object$/,
    );
    assert.throws(() => parseRecord(bytesOf('1'), 'loose.json'), {
      message: 'loose.json holds number 1; expected one JSON object',
    });
  });

  it('reads every JSONL line as an object, refusing a line of another shape', () => {
    assert.deepEqual(readLines(pkg, 'lines.jsonl').records, [{ a: 1 }, { b: 2 }]);
    assert.equal(readLines(pkg, 'lines.jsonl').ref.artifact_sha256, digestOf('{"a":1}\n{"b":2}'));
    assert.throws(() => readLines(pkg, 'mixed.jsonl'), {
      message: `${DIRECTORY}/mixed.jsonl line 2 is not one JSON object; expected a record`,
    });
  });
});

describe('typed members', () => {
  const record = { s: 'v', i: 2, f: 1.5, big: 2 ** 53, b: false, o: { k: 1 }, os: [{ k: 1 }], mixed: [{ k: 1 }, 2] };

  it('reads each member of its type', () => {
    assert.equal(stringOf(record, 's', 'subject'), 'v');
    assert.equal(integerOf(record, 'i', 'subject'), 2);
    assert.equal(booleanOf(record, 'b', 'subject'), false);
    assert.deepEqual(objectOf(record, 'o', 'subject'), { k: 1 });
    assert.deepEqual(objectsOf(record, 'os', 'subject'), [{ k: 1 }]);
  });

  it('refuses an absent member or one of another type, naming the subject and the shape', () => {
    assert.throws(() => stringOf(record, 'i', 'subject'), { message: 'subject: i is number 2; expected a string' });
    assert.throws(() => integerOf(record, 's', 'subject'), {
      message: 'subject: s is string "v"; expected a safe integer',
    });
    assert.throws(() => integerOf(record, 'f', 'subject'), /f is .*expected a safe integer/);
    assert.throws(() => integerOf(record, 'big', 'subject'), /big is .*expected a safe integer/);
    assert.throws(() => booleanOf(record, 'absent', 'subject'), {
      message: 'subject: absent is absent; expected a boolean',
    });
    assert.throws(() => objectOf(record, 'os', 'subject'), {
      message: 'subject: os is array [{"k":1}]; expected an object',
    });
    assert.throws(() => objectsOf(record, 'o', 'subject'), {
      message: 'subject: o is object {"k":1}; expected an array of objects',
    });
    assert.throws(
      () => objectsOf(record, 'mixed', 'subject'),
      /mixed is array \[\{"k":1\},2\]; expected an array of objects/,
    );
  });

  it('never reads an inherited name as a member (A-05)', () => {
    assert.equal(memberOf({}, 'constructor'), undefined);
    assert.equal(memberOf({ constructor: 1 }, 'constructor'), 1);
  });

  it('orders references by artifact path, equal paths as equal', () => {
    const ref = (artifact_path: string): ArtifactRef => ({
      package_index_sha256: 'p',
      artifact_path,
      artifact_sha256: 's',
    });
    assert.deepEqual(
      [ref('b'), ref('a'), ref('c')].sort(byArtifactPath).map((one) => one.artifact_path),
      ['a', 'b', 'c'],
    );
    assert.equal(byArtifactPath(ref('a'), ref('b')), -1);
    assert.equal(byArtifactPath(ref('b'), ref('a')), 1);
    assert.equal(byArtifactPath(ref('a'), ref('a')), 0);
  });
});
