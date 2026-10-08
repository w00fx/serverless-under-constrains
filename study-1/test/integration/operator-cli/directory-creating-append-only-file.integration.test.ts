// The absolute-path journal binding over a real temporary directory (design §10.1 A1): admission
// names its preflight journal `<evidence root>/admission-attempts/<id>/preflight-journal.jsonl`
// before anything has created that directory, so the binding creates the parent directories first.
// Regression: the admitter bound the bare `NodeAppendOnlyFile`, which appends into an existing
// directory only, and the first real `rua probe admit` on a fresh evidence root failed A1 with
// ADMISSION_EVIDENCE_UNWRITABLE (ENOENT) (decision 84).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { NodeAppendOnlyFile } from '../../../src/event-journal/node/node-append-only-file.ts';
import { DirectoryCreatingAppendOnlyFile } from '../../../src/operator-cli/node/directory-creating-append-only-file.ts';

const LINE = new TextEncoder().encode('{"a":1}\n');

describe('DirectoryCreatingAppendOnlyFile', () => {
  let root = '';

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'rua-attempts-'));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is needed: the bare binding cannot append into a directory that does not exist yet', async () => {
    const path = join(root, 'bare', 'admission-attempts', 'a1', 'preflight-journal.jsonl');
    assert.deepEqual(await new NodeAppendOnlyFile().append(path, LINE), { kind: 'not_written', code: 'ENOENT' });
  });

  it('appends into a fresh evidence root, creating the attempt directory', async () => {
    const path = join(root, 'evidence', 'admission-attempts', 'a2', 'preflight-journal.jsonl');
    const journal = new DirectoryCreatingAppendOnlyFile();
    assert.deepEqual(await journal.append(path, LINE), { kind: 'appended' });
    assert.deepEqual(await journal.append(path, new TextEncoder().encode('{"a":2}\n')), { kind: 'appended' });
    assert.equal(readFileSync(path, 'utf8'), '{"a":1}\n{"a":2}\n');
  });

  it('finalizes a journal whose directory does not exist yet as an empty read-only file', async () => {
    const path = join(root, 'evidence', 'admission-attempts', 'a3', 'preflight-journal.jsonl');
    const journal = new DirectoryCreatingAppendOnlyFile();
    assert.deepEqual(await journal.finalize(path), { kind: 'finalized' });
    assert.equal(readFileSync(path, 'utf8'), '');
    assert.equal(statSync(path).mode & 0o222, 0);
    assert.equal((await journal.append(path, LINE)).kind, 'not_written');
  });

  it('reports the inner failure when the parent cannot be a directory', async () => {
    writeFileSync(join(root, 'blocker'), 'file');
    const journal = new DirectoryCreatingAppendOnlyFile();
    assert.notEqual((await journal.append(join(root, 'blocker', 'journal.jsonl'), LINE)).kind, 'appended');
    assert.notEqual((await journal.finalize(join(root, 'blocker', 'journal.jsonl'))).kind, 'finalized');
  });
});
