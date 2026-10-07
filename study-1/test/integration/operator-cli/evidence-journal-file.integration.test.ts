// The evidence-root journal binding over a real temporary directory (design §7 journals;
// BR-RUA-035): a journal path is resolved below the evidence root with its parent directories
// created, appends and finalization are the inner file's, and a path that would leave the root is
// refused before anything is opened.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { EvidenceJournalFile, INVALID_JOURNAL_PATH } from '../../../src/operator-cli/node/evidence-journal-file.ts';

describe('EvidenceJournalFile', () => {
  let root = '';

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'rua-journals-'));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('appends below the evidence root, creating the parent directories', async () => {
    const journals = new EvidenceJournalFile(root);
    const path = 'runs/r1/runner/runner-journal.jsonl';
    assert.deepEqual(await journals.append(path, new TextEncoder().encode('{"a":1}\n')), { kind: 'appended' });
    assert.deepEqual(await journals.append(path, new TextEncoder().encode('{"a":2}\n')), { kind: 'appended' });
    assert.equal(readFileSync(join(root, path), 'utf8'), '{"a":1}\n{"a":2}\n');
    assert.deepEqual(await journals.finalize(path), { kind: 'finalized' });
    const after = await journals.append(path, new TextEncoder().encode('{"a":3}\n'));
    assert.equal(after.kind, 'not_written');
  });

  it('refuses a path outside the root, or not normalized, before opening anything', async () => {
    const journals = new EvidenceJournalFile(root);
    for (const path of ['../escape.jsonl', '/abs.jsonl', 'runs//x.jsonl', '']) {
      assert.deepEqual(await journals.append(path, new Uint8Array([1])), {
        kind: 'not_written',
        code: INVALID_JOURNAL_PATH,
      });
      assert.deepEqual(await journals.finalize(path), { kind: 'failed', code: INVALID_JOURNAL_PATH });
    }
    assert.equal(existsSync(join(root, '..', 'escape.jsonl')), false);
  });

  it('reports the inner failure when the parent cannot be a directory', async () => {
    writeFileSync(join(root, 'blocker'), 'file');
    const appended = await new EvidenceJournalFile(root).append('blocker/journal.jsonl', new Uint8Array([1]));
    assert.notEqual(appended.kind, 'appended');
  });
});
