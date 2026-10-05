// The git adapter reads committed source only (BR-RUA-028 "against current committed
// source"): tracked files of the revision's tree, with the revision's blob bytes.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { GitCommittedSourceReader } from '../../../../src/transport-qualification/scope/node/git-committed-source-reader.ts';
import { TemporaryScopeProject } from './support/temporary-scope-project.ts';

const encoder = new TextEncoder();

describe('GitCommittedSourceReader', () => {
  let project: TemporaryScopeProject;
  let firstCommit: string;

  before(() => {
    project = TemporaryScopeProject.create({
      '.gitignore': 'node_modules/\nignored.ts\n',
      'src/provider-client/a.ts': 'a1\n',
      'src/provider-client/nested/b.ts': 'b1\n',
      'src/provider-client-extra/c.ts': 'c1\n',
      'src/refund-provider/handler.ts': 'h1\n',
      'src/trial-oracle/oracle.ts': 'o1\n',
      'odd name [x].ts': 'odd\n',
    });
    firstCommit = project.head();
    project.write('src/provider-client/a.ts', 'a2\n');
    project.commit('second revision');
    project.write('src/provider-client/a.ts', 'a3-uncommitted\n');
    project.write('src/provider-client/untracked.ts', 'untracked\n');
    project.write('ignored.ts', 'ignored\n');
    project.installPackage('dep', '1.0.0', 'export const dep = 1;\n');
  });

  after(() => {
    project.dispose();
  });

  it('lists the committed files under each root, sorted, without untracked or ignored files', async () => {
    const reader = new GitCommittedSourceReader({ projectRoot: project.projectRoot });
    assert.deepEqual(await reader.listFiles(['src/provider-client', 'src/refund-provider/handler.ts']), [
      'src/provider-client/a.ts',
      'src/provider-client/nested/b.ts',
      'src/refund-provider/handler.ts',
    ]);
    assert.deepEqual(await reader.listFiles(['node_modules', 'ignored.ts', 'src/missing']), []);
  });

  it('treats roots as literal paths, not glob patterns', async () => {
    const reader = new GitCommittedSourceReader({ projectRoot: project.projectRoot });
    assert.deepEqual(await reader.listFiles(['odd name [x].ts']), ['odd name [x].ts']);
    assert.deepEqual(await reader.listFiles(['src/provider-client/*.ts']), []);
  });

  it('reads the committed bytes, not the working tree', async () => {
    const reader = new GitCommittedSourceReader({ projectRoot: project.projectRoot });
    assert.deepEqual(await reader.read('src/provider-client/a.ts'), encoder.encode('a2\n'));
  });

  it('reads an earlier revision when asked', async () => {
    const reader = new GitCommittedSourceReader({ projectRoot: project.projectRoot, revision: firstCommit });
    assert.deepEqual(await reader.read('src/provider-client/a.ts'), encoder.encode('a1\n'));
  });

  it('gives undefined for an untracked, ignored or absent path', async () => {
    const reader = new GitCommittedSourceReader({ projectRoot: project.projectRoot });
    assert.equal(await reader.read('src/provider-client/untracked.ts'), undefined);
    assert.equal(await reader.read('ignored.ts'), undefined);
    assert.equal(await reader.read('node_modules/dep/index.js'), undefined);
    assert.equal(await reader.read('src/nope.ts'), undefined);
  });

  it('fails loudly when the project is not inside a git work tree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'rua-scope-nogit-'));
    try {
      const reader = new GitCommittedSourceReader({ projectRoot: outside });
      await assert.rejects(reader.listFiles(['src']), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^git ls-tree HEAD in .+ exited \d+: .+; expected a git work tree with that revision$/s,
        );
        return true;
      });
      assert.equal(await reader.read('src/a.ts'), undefined);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
