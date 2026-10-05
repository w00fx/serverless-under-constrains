// Conformance of MemoryCommittedSourceReader with GitCommittedSourceReader over the same
// committed tree (RK-17): `git ls-tree -r` listing semantics (sorted, prefix roots on path
// segments, file roots, absent roots) and `git cat-file blob` bytes, with undefined for a path
// the revision does not contain.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { GitCommittedSourceReader } from '../../../../../src/transport-qualification/scope/node/git-committed-source-reader.ts';
import type { CommittedSourceReader } from '../../../../../src/transport-qualification/scope/scope-recomputation.ts';
import { MemoryCommittedSourceReader } from '../../../../unit/transport-qualification/scope/support/memory-committed-source-reader.ts';
import { TemporaryScopeProject } from '../support/temporary-scope-project.ts';

const FILES: Readonly<Record<string, string>> = {
  'src/provider-client/b.ts': 'b\n',
  'src/provider-client/a.ts': 'a\n',
  'src/provider-client/deep/z.json': '{}\n',
  'src/provider-client-extra/x.ts': 'x\n',
  'src/refund-provider/handler.ts': 'h\n',
  'Zeta.ts': 'upper\n',
};

const LISTINGS: readonly (readonly string[])[] = [
  ['src/provider-client'],
  ['src/provider-client/a.ts', 'src/refund-provider'],
  ['src'],
  ['src/missing', 'Zeta.ts'],
  [],
];
const READS = ['src/provider-client/a.ts', 'src/provider-client/deep/z.json', 'src/absent.ts', 'src'];

describe('MemoryCommittedSourceReader conformance with GitCommittedSourceReader', () => {
  let project: TemporaryScopeProject;
  let git: CommittedSourceReader;
  let memory: CommittedSourceReader;

  before(() => {
    project = TemporaryScopeProject.create(FILES);
    git = new GitCommittedSourceReader({ projectRoot: project.projectRoot });
    memory = new MemoryCommittedSourceReader(FILES);
  });

  after(() => {
    project.dispose();
  });

  for (const roots of LISTINGS.filter((list) => list.length > 0)) {
    it(`lists the same files for roots ${JSON.stringify(roots)}`, async () => {
      assert.deepEqual(await memory.listFiles(roots), await git.listFiles(roots));
    });
  }

  for (const path of READS) {
    it(`reads the same bytes for ${path}`, async () => {
      assert.deepEqual(await memory.read(path), await git.read(path));
    });
  }
});

describe('MemoryCommittedSourceReader controls', () => {
  it('commits, removes and records reads, returning copies of the bytes', async () => {
    const reader = new MemoryCommittedSourceReader({ 'a.ts': 'a' });
    reader.commit('b.ts', Uint8Array.from([1, 2]));
    reader.commit('c.ts', 'c');
    reader.remove('a.ts');
    assert.deepEqual(await reader.listFiles(['a.ts', 'b.ts', 'c.ts']), ['b.ts', 'c.ts']);
    const first = await reader.read('b.ts');
    first?.fill(9);
    assert.deepEqual(await reader.read('b.ts'), Uint8Array.from([1, 2]));
    assert.equal(await reader.read('a.ts'), undefined);
    assert.deepEqual(reader.reads(), ['b.ts', 'b.ts', 'a.ts']);
  });
});
