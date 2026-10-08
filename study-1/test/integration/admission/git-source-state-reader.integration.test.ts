// The production git provenance port (BR-RUA-042, design §10.1 A5) over real repositories: it
// reports what git says without writing the index (optional locks off), answers a failed
// `git status` with GIT_STATUS_FAILED, reads the lockfile's exact bytes, omits the tree id while
// HEAD does not resolve, and answers a lockfile it cannot read with LOCKFILE_UNREADABLE instead of
// throwing (A-05; WP-23 review).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { assessSourceProvenance } from '../../../src/admission/source-provenance.ts';
import { GitSourceStateReader } from '../../../src/admission/node/git-source-state-reader.ts';
import {
  TemporaryGitWorkTree,
  WORK_TREE_LOCKFILE,
  WORK_TREE_LOCKFILE_TEXT,
  WORK_TREE_SOURCE,
} from '../../support/admission/temporary-git-work-tree.ts';

describe('GitSourceStateReader', () => {
  it('admits a clean committed tree with its commit, tree, branch and lockfile bytes', async () => {
    const tree = TemporaryGitWorkTree.create();
    try {
      const state = await new GitSourceStateReader({
        repositoryRoot: tree.root,
        lockfilePath: WORK_TREE_LOCKFILE,
      }).readGitSourceState();
      assert.ok(state.ok);
      assert.deepEqual(state.value.lockfile, {
        path: WORK_TREE_LOCKFILE,
        tracked: true,
        bytes: new TextEncoder().encode(WORK_TREE_LOCKFILE_TEXT),
      });
      const verdict = assessSourceProvenance(state.value);
      assert.ok(verdict.passed, JSON.stringify(verdict));
      assert.equal(verdict.value.commit_sha, tree.head());
      assert.equal(verdict.value.tree_sha, tree.tree());
      assert.equal(verdict.value.branch, 'main');
    } finally {
      tree.dispose();
    }
  });

  it('never rewrites the index while reading a modified tree', async () => {
    const tree = TemporaryGitWorkTree.create();
    try {
      tree.write(WORK_TREE_SOURCE, 'export const refund = 3;\n');
      const index = join(tree.root, '.git', 'index');
      const before = statSync(index).mtimeMs;
      const state = await new GitSourceStateReader({
        repositoryRoot: tree.root,
        lockfilePath: WORK_TREE_LOCKFILE,
      }).readGitSourceState();
      assert.ok(state.ok);
      assert.equal(statSync(index).mtimeMs, before);
    } finally {
      tree.dispose();
    }
  });

  it('reads an unborn repository without a tree id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rua-admission-unborn-'));
    try {
      execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
      const state = await new GitSourceStateReader({
        repositoryRoot: root,
        lockfilePath: WORK_TREE_LOCKFILE,
      }).readGitSourceState();
      assert.ok(state.ok);
      assert.equal(state.value.tree_sha, undefined);
      assert.deepEqual(state.value.lockfile, { path: WORK_TREE_LOCKFILE, tracked: false });
      const verdict = assessSourceProvenance(state.value);
      assert.ok(!verdict.passed);
      assert.deepEqual(
        verdict.reasons.map((reason) => reason.code),
        ['LOCKFILE_MISSING', 'HEAD_UNRESOLVED', 'TREE_UNRESOLVED', 'LOCKFILE_UNTRACKED'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails with GIT_STATUS_FAILED outside a repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rua-admission-norepo-'));
    try {
      const state = await new GitSourceStateReader({
        repositoryRoot: root,
        lockfilePath: WORK_TREE_LOCKFILE,
      }).readGitSourceState();
      assert.ok(!state.ok);
      assert.equal(state.error.code, 'GIT_STATUS_FAILED');
      assert.match(state.error.detail, /not a git repository/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails with LOCKFILE_UNREADABLE when the lockfile path cannot be read', async () => {
    const tree = TemporaryGitWorkTree.create();
    try {
      tree.remove(WORK_TREE_LOCKFILE);
      mkdirSync(join(tree.root, WORK_TREE_LOCKFILE));
      const state = await new GitSourceStateReader({
        repositoryRoot: tree.root,
        lockfilePath: WORK_TREE_LOCKFILE,
      }).readGitSourceState();
      assert.ok(!state.ok);
      assert.equal(state.error.code, 'LOCKFILE_UNREADABLE');
      assert.match(state.error.detail, /EISDIR/);
    } finally {
      tree.dispose();
    }
  });
});
