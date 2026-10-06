// The git adapter reads committed source only (BR-RUA-028 "against current committed
// source"): tracked files of the revision's tree, with the revision's blob bytes. Only a path
// the revision's tree does not hold as a file reads as undefined; a git failure rejects with
// git's exit status and stderr, and recomputation reports it as SOURCE_READ_FAILED.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { GitCommittedSourceReader } from '../../../../src/transport-qualification/scope/node/git-committed-source-reader.ts';
import { recomputeScopeSnapshot } from '../../../../src/transport-qualification/scope/scope-recomputation.ts';
import { TRANSPORT_SCOPE_POLICY_PATH } from '../../../../src/transport-qualification/scope/scope-policy.ts';
import { FixedBundleInputResolver } from '../../../unit/transport-qualification/scope/support/fixed-bundle-input-resolver.ts';
import {
  SAMPLE_BUNDLES,
  SAMPLE_RUNTIME,
  SAMPLE_TIMING,
  cdkTemplate,
} from '../../../unit/transport-qualification/scope/support/scope-fixtures.ts';
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

  it('gives undefined for a directory, a directory with a trailing slash or a non-normalized path', async () => {
    const reader = new GitCommittedSourceReader({ projectRoot: project.projectRoot });
    assert.equal(await reader.read('src/provider-client'), undefined);
    assert.equal(await reader.read('src/provider-client/'), undefined);
    assert.equal(await reader.read('src/refund-provider/'), undefined);
    assert.equal(await reader.read('./src/refund-provider/handler.ts'), undefined);
    assert.deepEqual(await reader.read('src/refund-provider/handler.ts'), encoder.encode('h1\n'));
  });

  it('lists no file for no root, where git would list the whole tree', async () => {
    const reader = new GitCommittedSourceReader({ projectRoot: project.projectRoot });
    assert.deepEqual(await reader.listFiles([]), []);
  });

  it('fails loudly when the project is not inside a git work tree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'rua-scope-nogit-'));
    try {
      const reader = new GitCommittedSourceReader({ projectRoot: outside });
      const notRepository = (error: unknown): boolean => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^git ls-tree HEAD in .+ exited 128: fatal: not a git repository.*; expected a git work tree with that revision$/s,
        );
        return true;
      };
      await assert.rejects(reader.listFiles(['src']), notRepository);
      await assert.rejects(reader.read('src/a.ts'), notRepository);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('fails loudly for a revision the repository does not have (regression: verify/eng-git-reader.log)', async () => {
    const reader = new GitCommittedSourceReader({ projectRoot: project.projectRoot, revision: 'no-such-revision' });
    const badRevision = (error: unknown): boolean => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /^git ls-tree no-such-revision in .+ exited 128: fatal: Not a valid object name no-such-revision; expected a git work tree with that revision$/,
      );
      return true;
    };
    await assert.rejects(reader.read('src/provider-client/a.ts'), badRevision);
    await assert.rejects(reader.listFiles(['src']), badRevision);
  });

  it('fails loudly when the project root does not exist', async () => {
    const reader = new GitCommittedSourceReader({ projectRoot: join(project.repositoryRoot, 'no-such-dir') });
    await assert.rejects(reader.read('src/provider-client/a.ts'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^git ls-tree HEAD in .+no-such-dir exited 1: .*ENOENT.*; expected a git work tree/s);
      return true;
    });
  });

  it('makes recomputation report a bad revision as SOURCE_READ_FAILED, not as an uncommitted policy', async () => {
    const result = await recomputeScopeSnapshot(
      {
        template: cdkTemplate(),
        runtime: SAMPLE_RUNTIME,
        timing: SAMPLE_TIMING,
        provider_warmup: { invocations_per_trial: 1 },
      },
      {
        sources: new GitCommittedSourceReader({ projectRoot: project.projectRoot, revision: 'no-such-revision' }),
        bundles: new FixedBundleInputResolver(SAMPLE_BUNDLES),
        validator: createRecordValidator(),
      },
    );
    assert.ok(!result.ok);
    assert.deepEqual(
      result.error.map((reason) => reason.code),
      ['SOURCE_READ_FAILED'],
    );
    assert.match(
      result.error[0]?.detail ?? '',
      new RegExp(
        `^reading committed ${TRANSPORT_SCOPE_POLICY_PATH.replaceAll('.', '\\.')} failed: git ls-tree no-such-revision .+ ` +
          'exited 128: fatal: Not a valid object name no-such-revision; expected a git work tree with that revision; ' +
          'expected the admitted revision to be readable$',
      ),
    );
  });
});
