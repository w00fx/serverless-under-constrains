// Named fake of the revision check's workspace (design §12.2): known revisions resolve to scripted
// commits and trees, the golden suite returns a scripted run, and each step can be made to fail.
// It keeps the contract `revision-workspace-contract.ts` states for both this fake and the real
// `GitRevisionWorkspace`: an unknown revision fails with `REVISION_UNRESOLVED`, every checkout is
// released once, and a second release, or a release of a checkout it never made, is refused.

import type { GoldenSuiteRun } from '../../../../src/admission/admission-ports.ts';
import { revisionReason } from '../../../../src/operator-cli/oracle-revision-check.ts';
import type { RevisionCheckout, RevisionWorkspace } from '../../../../src/operator-cli/oracle-revision-check.ts';
import { err, ok } from '../../../../src/record-contract/primitives.ts';
import type { Result, StructuredReason } from '../../../../src/record-contract/primitives.ts';

/** A commit the fake knows, and the tree it has. */
export interface ScriptedRevision {
  readonly commit_sha: string;
  readonly tree_sha: string;
}

export type WorkspaceStep = 'install' | 'golden' | 'release';

export class ScriptedRevisionWorkspace implements RevisionWorkspace {
  readonly #revisions: ReadonlyMap<string, ScriptedRevision>;
  readonly #run: GoldenSuiteRun;
  readonly #failures = new Map<WorkspaceStep, StructuredReason>();
  readonly #open = new Set<RevisionCheckout>();
  /** Every call, in order, as `<step> <commit>`. */
  readonly calls: string[] = [];

  constructor(revisions: ReadonlyMap<string, ScriptedRevision>, run: GoldenSuiteRun) {
    this.#revisions = revisions;
    this.#run = run;
  }

  /** Makes every later call of `step` fail with `reason`. */
  fail(step: WorkspaceStep, reason: StructuredReason): void {
    this.#failures.set(step, reason);
  }

  /** How many checkouts are not released yet. */
  openCheckouts(): number {
    return this.#open.size;
  }

  checkout(revision: string): Promise<Result<RevisionCheckout, StructuredReason>> {
    this.calls.push(`checkout ${revision}`);
    const known = this.#revisions.get(revision);
    if (known === undefined) {
      return Promise.resolve(
        err(revisionReason('REVISION_UNRESOLVED', `no commit is named ${revision}; expected a known revision`)),
      );
    }
    const checkout: RevisionCheckout = { ...known, study_root: `/scripted/${known.commit_sha}/study-1/` };
    this.#open.add(checkout);
    return Promise.resolve(ok(checkout));
  }

  install(checkout: RevisionCheckout): Promise<StructuredReason | undefined> {
    this.calls.push(`install ${checkout.commit_sha}`);
    return Promise.resolve(this.#failures.get('install'));
  }

  runGoldenSuite(checkout: RevisionCheckout): Promise<Result<GoldenSuiteRun, StructuredReason>> {
    this.calls.push(`golden ${checkout.commit_sha}`);
    const failure = this.#failures.get('golden');
    return Promise.resolve(failure === undefined ? ok(this.#run) : err(failure));
  }

  release(checkout: RevisionCheckout): Promise<StructuredReason | undefined> {
    this.calls.push(`release ${checkout.commit_sha}`);
    if (!this.#open.delete(checkout)) {
      return Promise.resolve(
        revisionReason(
          'REVISION_WORKTREE_UNKNOWN',
          `${checkout.study_root} is not a worktree this workspace created; expected a checkout it returned`,
        ),
      );
    }
    return Promise.resolve(this.#failures.get('release'));
  }
}
