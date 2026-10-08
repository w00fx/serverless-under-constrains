// The evidence archive against a real tar (close-out): the system tar extracts what
// tools/lib/evidence-archive.ts writes, gzipped as tools/redact-evidence.ts publishes it, to the
// same files, including a path long enough to need the prefix field, an empty file and binary bytes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { ustarArchive } from '../../../tools/lib/evidence-archive.ts';

const scratchRoots: string[] = [];
after(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

// As long as the longest path of the Study 1 copy: a deployment bundle under its asset folder.
const LONG = `variant-validations/00000000-0000-4000-8000-000000000002/admission/deployment-assembly/asset.${'d'.repeat(64)}/index.mjs`;
const FILES = new Map<string, Uint8Array>([
  [LONG, new TextEncoder().encode('export const handler = () => 1;\n')],
  ['runs/00000000-0000-4000-8000-000000000001/package-index.json', new TextEncoder().encode('{"entries":[]}')],
  ['verifications/x/empty.json', new Uint8Array(0)],
  [
    'runs/00000000-0000-4000-8000-000000000001/binary.bin',
    Uint8Array.from({ length: 1536 }, (_, index) => index % 256),
  ],
]);

describe('evidence archive', () => {
  it('extracts with the system tar to exactly the files it was written from', () => {
    const root = mkdtempSync(join(tmpdir(), 'rua-archive-'));
    scratchRoots.push(root);
    writeFileSync(join(root, 'copy.tar.gz'), gzipSync(ustarArchive(FILES), { level: 9 }));
    const listed = spawnSync('tar', ['-tzf', 'copy.tar.gz'], { cwd: root, encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split('\n'), [...FILES.keys()]);
    const extracted = spawnSync('tar', ['-xzf', 'copy.tar.gz'], { cwd: root, encoding: 'utf8' });
    assert.deepEqual([extracted.status, extracted.stderr], [0, '']);
    for (const [path, bytes] of FILES) {
      assert.deepEqual(new Uint8Array(readFileSync(join(root, path))), bytes, path);
    }
  });
});
