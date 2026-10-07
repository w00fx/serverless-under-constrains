// Local binding of the revision check's workspace (design §11 `oracle revision-check`, AC-RUA-055):
// `git worktree add --detach` of the revision into a fresh temporary directory, `npm ci` of its
// locked dependencies there, `npm run test:golden -- --report-json` through admission's golden
// suite reader, and `git worktree remove --force` afterwards. Every git and npm call goes through
// the injected command runner with an explicit argument vector, so no shell parses a revision.
// The suite must run as its own top-level test runner: `NODE_TEST_CONTEXT`, which `node --test`
// sets for the processes it starts, would make the suite's runner report to a parent that is not
// listening, so it is never passed on (an e2e driver starts the CLI from `node --test`).

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { GoldenSuiteReader } from '../../admission/node/golden-suite-reader.ts';
import type { GoldenSuiteRun } from '../../admission/admission-ports.ts';
import { commandSucceeded, describeCommandResult } from '../../deployment-assembly/command-outcome.ts';
import type { CommandRunner } from '../../deployment-assembly/command-runner.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../../record-contract/primitives.ts';
import { revisionReason } from '../oracle-revision-check.ts';
import type { RevisionCheckout, RevisionWorkspace } from '../oracle-revision-check.ts';

export interface GitRevisionWorkspaceDeps {
  readonly runner: CommandRunner;
  /** Absolute path of the operator's study root; its repository holds the revisions. */
  readonly studyRoot: string;
  /** The directory temporary worktrees are created in, for example `os.tmpdir()`. */
  readonly tempRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly gitExecutable: string;
  readonly npmExecutable: string;
}

const NESTED_TEST_CONTEXT = 'NODE_TEST_CONTEXT';

/** Where one checkout of this workspace lives. */
interface WorktreePlacement {
  readonly repository_root: string;
  readonly directory: string;
  readonly worktree: string;
}

/**
 * Temporary git worktrees of the operator's repository.
 *
 * @example
 * const workspace = new GitRevisionWorkspace({ runner, studyRoot, tempRoot: tmpdir(), env, gitExecutable: 'git', npmExecutable: 'npm' });
 */
export class GitRevisionWorkspace implements RevisionWorkspace {
  readonly #deps: GitRevisionWorkspaceDeps;
  readonly #placements = new WeakMap<RevisionCheckout, WorktreePlacement>();

  constructor(deps: GitRevisionWorkspaceDeps) {
    const env = Object.fromEntries(Object.entries(deps.env).filter(([name]) => name !== NESTED_TEST_CONTEXT));
    this.#deps = { ...deps, env };
  }

  async checkout(revision: string): Promise<Result<RevisionCheckout, StructuredReason>> {
    const located = await this.#locate(revision);
    if (!located.ok) {
      return err(revisionReason('REVISION_UNRESOLVED', `${located.error}; expected ${revision} to name a commit`));
    }
    const { root, prefix, commit, tree } = located.value;
    const directory = mkdtempSync(join(this.#deps.tempRoot, 'rua-revision-check-'));
    const worktree = join(directory, 'tree');
    const added = await this.#git(root, ['worktree', 'add', '--detach', '--quiet', worktree, commit]);
    if (!added.ok) {
      rmSync(directory, { recursive: true, force: true });
      return err(
        revisionReason('REVISION_NOT_CHECKED_OUT', `${added.error}; expected a temporary worktree of ${commit}`),
      );
    }
    const checkout: RevisionCheckout = { commit_sha: commit, tree_sha: tree, study_root: join(worktree, prefix) };
    this.#placements.set(checkout, { repository_root: root, directory, worktree });
    return ok(checkout);
  }

  async install(checkout: RevisionCheckout): Promise<StructuredReason | undefined> {
    const result = await this.#deps.runner.run({
      executable: this.#deps.npmExecutable,
      args: ['ci', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'],
      cwd: checkout.study_root,
      env: this.#deps.env,
    });
    return commandSucceeded(result)
      ? undefined
      : revisionReason(
          'REVISION_DEPENDENCIES_NOT_INSTALLED',
          `npm ci at ${checkout.commit_sha} ${describeCommandResult(result)}; expected the locked dependencies installed`,
        );
  }

  async runGoldenSuite(checkout: RevisionCheckout): Promise<Result<GoldenSuiteRun, StructuredReason>> {
    const placement = this.#placements.get(checkout);
    if (placement === undefined) {
      return err(unknownCheckout(checkout));
    }
    const reader = new GoldenSuiteReader({
      runner: this.#deps.runner,
      studyRoot: checkout.study_root,
      reportPath: join(placement.directory, 'golden-report.json'),
      npmExecutable: this.#deps.npmExecutable,
      env: this.#deps.env,
    });
    const run = await reader.readGoldenSuiteRun();
    return run.ok
      ? run
      : err(
          revisionReason(run.error.code, `${run.error.detail}; expected the golden suite to run and write its report`),
        );
  }

  async release(checkout: RevisionCheckout): Promise<StructuredReason | undefined> {
    const placement = this.#placements.get(checkout);
    if (placement === undefined) {
      return unknownCheckout(checkout);
    }
    this.#placements.delete(checkout);
    const removed = await this.#git(placement.repository_root, ['worktree', 'remove', '--force', placement.worktree]);
    rmSync(placement.directory, { recursive: true, force: true });
    return removed.ok
      ? undefined
      : revisionReason(
          'REVISION_WORKTREE_NOT_REMOVED',
          `${removed.error}; expected the temporary worktree ${placement.worktree} removed`,
        );
  }

  // The repository, the study root's prefix inside it, and the commit and tree of the revision.
  async #locate(
    revision: string,
  ): Promise<
    Result<{ readonly root: string; readonly prefix: string; readonly commit: string; readonly tree: string }, string>
  > {
    const study = this.#deps.studyRoot;
    const root = await this.#git(study, ['rev-parse', '--show-toplevel']);
    if (!root.ok) {
      return root;
    }
    const prefix = await this.#git(study, ['rev-parse', '--show-prefix']);
    if (!prefix.ok) {
      return prefix;
    }
    const commit = await this.#git(study, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
    if (!commit.ok) {
      return commit;
    }
    const tree = await this.#git(study, ['rev-parse', '--verify', '--end-of-options', `${commit.value}^{tree}`]);
    return tree.ok ? ok({ root: root.value, prefix: prefix.value, commit: commit.value, tree: tree.value }) : tree;
  }

  // One git call; its trimmed stdout, or how it ended.
  async #git(cwd: string, args: readonly string[]): Promise<Result<string, string>> {
    const result = await this.#deps.runner.run({
      executable: this.#deps.gitExecutable,
      args,
      cwd,
      env: this.#deps.env,
    });
    if (result.kind !== 'exited' || result.exit_code !== 0) {
      return err(`git ${args.join(' ')} ${describeCommandResult(result)}`);
    }
    return ok(result.stdout.trim());
  }
}

function unknownCheckout(checkout: RevisionCheckout): StructuredReason {
  return revisionReason(
    'REVISION_WORKTREE_UNKNOWN',
    `${checkout.study_root} is not a worktree this workspace created; expected a checkout it returned`,
  );
}
