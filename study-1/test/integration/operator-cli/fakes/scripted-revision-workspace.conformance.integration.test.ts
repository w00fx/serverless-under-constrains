// Conformance of ScriptedRevisionWorkspace (design §12.2, RK-17): the contract the revision check
// relies on holds for the fake and for the production GitRevisionWorkspace over a real git
// repository with a runnable miniature golden suite. Git documents that `rev-parse --verify`
// fails for a name that resolves to no object, and that `worktree add --detach` checks out the
// commit with a detached HEAD (https://git-scm.com/docs/git-rev-parse,
// https://git-scm.com/docs/git-worktree).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChildProcessCommandRunner } from '../../../../src/deployment-assembly/node/child-process-command-runner.ts';
import { GitRevisionWorkspace } from '../../../../src/operator-cli/node/git-revision-workspace.ts';
import type { RevisionWorkspace } from '../../../../src/operator-cli/oracle-revision-check.ts';
import { FakeGoldenSuiteRunner } from '../../../support/admission/fake-golden-suite-runner.ts';
import { MiniatureRevisionRepository } from '../support/miniature-revision-repository.ts';
import { ScriptedRevisionWorkspace } from './scripted-revision-workspace.ts';

interface ContractSubject {
  readonly workspace: RevisionWorkspace;
  readonly commit: string;
  readonly tree: string;
}

function definedEnvironment(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function describeRevisionWorkspaceContract(name: string, subject: () => ContractSubject): void {
  describe(`${name} keeps the revision workspace contract`, () => {
    it('refuses a revision that names no commit, leaving nothing to release', async () => {
      const checkout = await subject().workspace.checkout('no-such-revision');
      assert.equal(checkout.ok, false);
      assert.equal(checkout.error.code, 'REVISION_UNRESOLVED');
      assert.equal(checkout.error.subject, 'BR-RUA-055');
      assert.match(checkout.error.detail, /no-such-revision/);
    });

    it('checks out the commit and tree the revision names, runs the suite, and releases once', async () => {
      const { workspace, commit, tree } = subject();
      const checkout = await workspace.checkout(commit);
      assert.equal(checkout.ok, true);
      assert.equal(checkout.value.commit_sha, commit);
      assert.equal(checkout.value.tree_sha, tree);
      assert.equal(await workspace.install(checkout.value), undefined);
      const run = await workspace.runGoldenSuite(checkout.value);
      assert.equal(run.ok, true);
      assert.equal(run.value.exit_code, 0);
      assert.ok(run.value.case_declarations.length > 0);
      assert.equal(await workspace.release(checkout.value), undefined);
      const again = await workspace.release(checkout.value);
      assert.equal(again?.code, 'REVISION_WORKTREE_UNKNOWN');
    });
  });
}

const fakeRun = await new FakeGoldenSuiteRunner().readGoldenSuiteRun();
assert.equal(fakeRun.ok, true);
const FAKE_COMMIT = 'a'.repeat(40);
const FAKE_TREE = 'b'.repeat(40);
describeRevisionWorkspaceContract('ScriptedRevisionWorkspace', () => ({
  workspace: new ScriptedRevisionWorkspace(
    new Map([[FAKE_COMMIT, { commit_sha: FAKE_COMMIT, tree_sha: FAKE_TREE }]]),
    fakeRun.value,
  ),
  commit: FAKE_COMMIT,
  tree: FAKE_TREE,
}));

describe('GitRevisionWorkspace over a real repository', () => {
  let repository: MiniatureRevisionRepository;
  before(() => {
    repository = MiniatureRevisionRepository.create();
  });
  after(() => {
    repository.dispose();
  });

  const workspace = (): GitRevisionWorkspace =>
    new GitRevisionWorkspace({
      runner: new ChildProcessCommandRunner(),
      studyRoot: repository.studyRoot,
      tempRoot: tmpdir(),
      env: definedEnvironment(),
      gitExecutable: 'git',
      npmExecutable: 'npm',
    });

  describeRevisionWorkspaceContract('GitRevisionWorkspace', () => ({
    workspace: workspace(),
    commit: repository.final_commit,
    tree: repository.final_tree,
  }));

  it('checks the revision out in a temporary worktree outside the operator work tree, and removes it', async () => {
    const real = workspace();
    const checkout = await real.checkout(repository.regressed_commit);
    assert.equal(checkout.ok, true);
    const studyRoot = checkout.value.study_root;
    assert.ok(!studyRoot.startsWith(repository.tree.root));
    assert.match(
      readFileSync(join(studyRoot, 'test/golden/trial-oracle/miniature/miniature.golden.test.ts'), 'utf8'),
      /false/,
    );
    assert.equal(await real.install(checkout.value), undefined);
    const run = await real.runGoldenSuite(checkout.value);
    assert.equal(run.ok, true);
    assert.equal(run.value.exit_code, 1);
    assert.equal(await real.release(checkout.value), undefined);
    assert.equal(existsSync(studyRoot), false);
    assert.doesNotMatch(repository.tree.git(['worktree', 'list']), /rua-revision-check-/);
  });

  it('reports a revision whose dependencies do not install, and still releases it', async () => {
    repository.tree.write('study-1/package-lock.json', '{"lockfileVersion": 3, "packages": {"": {"name": "other"}}}\n');
    repository.tree.write('study-1/package.json', '{"name":"miniature-study","dependencies":{"left-pad":"1.3.0"}}');
    repository.tree.commit('break the lockfile');
    const broken = repository.tree.head();
    const real = workspace();
    const checkout = await real.checkout(broken);
    assert.equal(checkout.ok, true);
    const installed = await real.install(checkout.value);
    assert.equal(installed?.code, 'REVISION_DEPENDENCIES_NOT_INSTALLED');
    assert.match(installed.detail, new RegExp(`npm ci at ${broken} exited with status [1-9]`));
    assert.equal(await real.release(checkout.value), undefined);
  });
});
