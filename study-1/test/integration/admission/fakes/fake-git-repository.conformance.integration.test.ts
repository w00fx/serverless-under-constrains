// FakeGitRepository conformance (design §12.2): for every state the fake scripts, the production
// `GitSourceStateReader` over a real temporary repository in the same state leads admission to
// the same A5 conclusion: the same pass or reason codes, the same commit, tree and branch, and
// the same parsed status entries.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { GitSourceState } from '../../../../src/admission/admission-ports.ts';
import { parseGitPorcelainV2 } from '../../../../src/admission/git-porcelain.ts';
import { assessSourceProvenance } from '../../../../src/admission/source-provenance.ts';
import { GitSourceStateReader } from '../../../../src/admission/node/git-source-state-reader.ts';
import { FakeGitRepository } from '../../../support/admission/fake-git-repository.ts';
import {
  TemporaryGitWorkTree,
  WORK_TREE_LOCKFILE,
  WORK_TREE_LOCKFILE_TEXT,
  WORK_TREE_SOURCE,
} from '../../../support/admission/temporary-git-work-tree.ts';

interface Conclusion {
  readonly codes: readonly string[];
  readonly commit: string | undefined;
  readonly branch: string | undefined;
  readonly entries: readonly string[];
  readonly lockfile: readonly [boolean, boolean];
}

function conclusionOf(state: GitSourceState): Conclusion {
  const verdict = assessSourceProvenance(state);
  const status = parseGitPorcelainV2(state.status_porcelain_v2);
  return {
    codes: verdict.passed ? [] : verdict.reasons.map((reason) => reason.code),
    commit: status.commit_sha,
    branch: status.branch,
    entries: status.entries.map((entry) => `${entry.kind} ${entry.path}`),
    lockfile: [state.lockfile.tracked, state.lockfile.bytes !== undefined],
  };
}

async function conclusions(tree: TemporaryGitWorkTree, fake: FakeGitRepository): Promise<readonly Conclusion[]> {
  const real = await new GitSourceStateReader({
    repositoryRoot: tree.root,
    lockfilePath: WORK_TREE_LOCKFILE,
  }).readGitSourceState();
  const scripted = await fake.readGitSourceState();
  assert.ok(real.ok && scripted.ok, JSON.stringify({ real, scripted }));
  assert.equal(real.value.tree_sha, scripted.value.tree_sha);
  return [conclusionOf(real.value), conclusionOf(scripted.value)];
}

describe('FakeGitRepository conforms to GitSourceStateReader', () => {
  let tree: TemporaryGitWorkTree;
  let fake: FakeGitRepository;

  beforeEach(() => {
    tree = TemporaryGitWorkTree.create();
    fake = new FakeGitRepository({
      commit_sha: tree.head(),
      tree_sha: tree.tree(),
      branch: 'main',
      lockfile_path: WORK_TREE_LOCKFILE,
      lockfile_text: WORK_TREE_LOCKFILE_TEXT,
    });
  });

  afterEach(() => {
    tree.dispose();
  });

  it('a clean tree on a branch', async () => {
    const [real, scripted] = await conclusions(tree, fake);
    assert.deepEqual(scripted, real);
    assert.deepEqual(real?.codes, []);
  });

  it('an untracked file', async () => {
    tree.write('study-1/notes.txt', 'todo\n');
    fake.addUntracked('study-1/notes.txt');
    const [real, scripted] = await conclusions(tree, fake);
    assert.deepEqual(scripted, real);
    assert.deepEqual(real?.codes, ['UNTRACKED_FILE']);
  });

  it('a modified tracked file and a modified lockfile', async () => {
    tree.write(WORK_TREE_SOURCE, 'export const refund = 2;\n');
    tree.write(WORK_TREE_LOCKFILE, '{"name":"study-1","lockfileVersion":3,"packages":{}}\n');
    fake.modify(WORK_TREE_LOCKFILE);
    fake.modify(WORK_TREE_SOURCE);
    const [real, scripted] = await conclusions(tree, fake);
    assert.deepEqual(scripted?.codes, real?.codes);
    assert.deepEqual([...(scripted?.entries ?? [])].sort(), [...(real?.entries ?? [])].sort());
    assert.deepEqual([...(real?.codes ?? [])].sort(), ['LOCKFILE_MODIFIED', 'TRACKED_FILE_MODIFIED']);
  });

  it('a staged rename', async () => {
    tree.git(['mv', WORK_TREE_SOURCE, 'study-1/src/refunds.ts']);
    fake.rename(WORK_TREE_SOURCE, 'study-1/src/refunds.ts');
    const [real, scripted] = await conclusions(tree, fake);
    assert.deepEqual(scripted, real);
    assert.deepEqual(real?.entries, ['renamed study-1/src/refunds.ts']);
  });

  it('an ignored file leaves the tree clean', async () => {
    tree.write('study-1/ignored/cache.bin', 'x');
    fake.ignore('study-1/ignored/cache.bin');
    const [real, scripted] = await conclusions(tree, fake);
    assert.deepEqual(scripted?.codes, real?.codes);
    assert.deepEqual(real?.codes, []);
  });

  it('a detached HEAD', async () => {
    tree.git(['checkout', '--quiet', '--detach']);
    fake.detachHead();
    const [real, scripted] = await conclusions(tree, fake);
    assert.deepEqual(scripted, real);
    assert.equal(real?.branch, undefined);
  });

  it('a merge in progress', async () => {
    writeFileSync(join(tree.root, '.git', 'MERGE_HEAD'), `${tree.head()}\n`);
    fake.startOperation('MERGE');
    const [real, scripted] = await conclusions(tree, fake);
    assert.deepEqual(scripted, real);
    assert.deepEqual(real?.codes, ['OPERATION_IN_PROGRESS']);
  });

  it('a rebase in progress', async () => {
    mkdirSync(join(tree.root, '.git', 'rebase-merge'));
    fake.startOperation('REBASE');
    const [real, scripted] = await conclusions(tree, fake);
    assert.deepEqual(scripted, real);
    assert.deepEqual(real?.codes, ['OPERATION_IN_PROGRESS']);
  });

  it('an untracked lockfile', async () => {
    tree.git(['rm', '--cached', '--quiet', WORK_TREE_LOCKFILE]);
    tree.git(['commit', '--quiet', '-m', 'untrack the lockfile']);
    fake = new FakeGitRepository({
      commit_sha: tree.head(),
      tree_sha: tree.tree(),
      branch: 'main',
      lockfile_path: WORK_TREE_LOCKFILE,
      lockfile_text: WORK_TREE_LOCKFILE_TEXT,
    });
    fake.untrackLockfile();
    const [real, scripted] = await conclusions(tree, fake);
    assert.deepEqual(scripted, real);
    assert.deepEqual(real?.codes, ['UNTRACKED_FILE', 'LOCKFILE_UNTRACKED']);
  });

  it('a deleted lockfile', async () => {
    tree.remove(WORK_TREE_LOCKFILE);
    fake.removeLockfile();
    const [real, scripted] = await conclusions(tree, fake);
    assert.deepEqual(scripted, real);
    assert.deepEqual(real?.codes, ['LOCKFILE_MISSING', 'LOCKFILE_MODIFIED']);
  });
});
