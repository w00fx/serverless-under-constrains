// FakeGitRepository (design §12.2): the git provenance port over an in-memory work tree. It
// emulates `GitSourceStateReader`: the status is the porcelain v2 `-z` text git prints (the
// `# branch.oid` and `# branch.head` headers, then one NUL-terminated record per entry, a rename
// followed by its original path), the tree id is present only while HEAD resolves, and the
// lockfile is reported with its tracked flag and bytes. Its conformance test runs both over the
// same states of a real temporary repository and compares what admission concludes.
//
// Test hooks: `addUntracked`, `modify`, `modifyLockfile`, `rename`, `ignore`, `dirtySubmodule`,
// `startOperation`, `detachHead`, `unborn`, `untrackLockfile`, `removeLockfile`, `failWith`.

import { ok, err } from '../../../src/record-contract/primitives.ts';
import type {
  GitProvenancePort,
  GitSourceState,
  InProgressOperation,
  PortFailure,
  PortResult,
} from '../../../src/admission/admission-ports.ts';
import { BRANCH, COMMIT_SHA, LOCKFILE_PATH, LOCKFILE_TEXT, TREE_SHA } from './admission-fixtures.ts';

const BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const FILE_MODES = '100644 100644 100644';
const SUBMODULE_MODES = '160000 160000 160000';

export interface FakeGitRepositoryOptions {
  readonly commit_sha?: string;
  readonly tree_sha?: string;
  readonly branch?: string;
  readonly lockfile_path?: string;
  readonly lockfile_text?: string;
}

/**
 * A scripted work tree; clean and on a branch by default.
 *
 * @example
 * const git = new FakeGitRepository();
 * git.addUntracked('study-1/notes.txt');
 * await git.readGitSourceState(); // status lists '? study-1/notes.txt'
 */
export class FakeGitRepository implements GitProvenancePort {
  readonly #records: string[] = [];
  readonly #inProgress = new Set<InProgressOperation>();
  readonly #lockfilePath: string;
  #commit: string | undefined;
  #tree: string | undefined;
  #branch: string | undefined;
  #lockfileBytes: Uint8Array | undefined;
  #lockfileTracked = true;
  #failure: PortFailure | undefined;
  #reads = 0;

  constructor(options: FakeGitRepositoryOptions = {}) {
    this.#commit = options.commit_sha ?? COMMIT_SHA;
    this.#tree = options.tree_sha ?? TREE_SHA;
    this.#branch = options.branch ?? BRANCH;
    this.#lockfilePath = options.lockfile_path ?? LOCKFILE_PATH;
    this.#lockfileBytes = new TextEncoder().encode(options.lockfile_text ?? LOCKFILE_TEXT);
  }

  /** An untracked file (`? <path>`). */
  addUntracked(path: string): void {
    this.#records.push(`? ${path}`);
  }

  /** A tracked file modified in the work tree (`1 .M N...`). */
  modify(path: string): void {
    this.#records.push(`1 .M N... ${FILE_MODES} ${BLOB} ${BLOB} ${path}`);
  }

  /** The lockfile modified in the work tree. */
  modifyLockfile(): void {
    this.modify(this.#lockfilePath);
  }

  /** A staged rename (`2 R. N...`), followed by its original path. */
  rename(from: string, to: string): void {
    this.#records.push(`2 R. N... ${FILE_MODES} ${BLOB} ${BLOB} R100 ${to}`, from);
  }

  /** An ignored file (`! <path>`). */
  ignore(path: string): void {
    this.#records.push(`! ${path}`);
  }

  /** A submodule whose work tree has modifications (`1 .M S.M.`). */
  dirtySubmodule(path: string): void {
    this.#records.push(`1 .M S.M. ${SUBMODULE_MODES} ${BLOB} ${BLOB} ${path}`);
  }

  /** A merge, rebase or cherry-pick left unfinished. */
  startOperation(operation: InProgressOperation): void {
    this.#inProgress.add(operation);
  }

  /** HEAD points at a commit, not a branch. */
  detachHead(): void {
    this.#branch = undefined;
  }

  /** A repository with no commit yet: HEAD and its tree do not resolve. */
  unborn(): void {
    this.#commit = undefined;
    this.#tree = undefined;
  }

  /** The lockfile exists but git does not track it, so status lists it as untracked too. */
  untrackLockfile(): void {
    this.#lockfileTracked = false;
    this.addUntracked(this.#lockfilePath);
  }

  /** The tracked lockfile was deleted from the work tree (`1 .D`): still tracked, no bytes. */
  removeLockfile(): void {
    this.#lockfileBytes = undefined;
    this.#records.push(`1 .D N... 100644 100644 000000 ${BLOB} ${BLOB} ${this.#lockfilePath}`);
  }

  /** Every later read fails, as a `git status` that exits non-zero does. */
  failWith(code: string, detail: string): void {
    this.#failure = { code, detail };
  }

  /** How many times the port was read. */
  readCount(): number {
    return this.#reads;
  }

  readGitSourceState(): PortResult<GitSourceState> {
    this.#reads += 1;
    if (this.#failure !== undefined) {
      return Promise.resolve(err(this.#failure));
    }
    const headers = [`# branch.oid ${this.#commit ?? '(initial)'}`, `# branch.head ${this.#branch ?? '(detached)'}`];
    const status = [...headers, ...this.#records].map((record) => `${record}\0`).join('');
    return Promise.resolve(
      ok({
        status_porcelain_v2: status,
        ...(this.#tree === undefined ? {} : { tree_sha: this.#tree }),
        in_progress: [...this.#inProgress],
        lockfile: {
          path: this.#lockfilePath,
          tracked: this.#lockfileTracked,
          ...(this.#lockfileBytes === undefined ? {} : { bytes: Uint8Array.from(this.#lockfileBytes) }),
        },
      }),
    );
  }
}
