// The production git provenance port (BR-RUA-042, design §10.1 A5): reads, never writes. It runs
// `git status --porcelain=v2 --branch -z --untracked-files=all --ignore-submodules=none`, resolves
// `HEAD^{tree}`, asks git where its in-progress markers live (`MERGE_HEAD`, `CHERRY_PICK_HEAD`,
// `rebase-merge`, `rebase-apply`) and checks whether each exists, checks that the lockfile is
// tracked (`git ls-files --error-unmatch`), and reads the lockfile's bytes. Git runs without a
// shell, with optional locks disabled so a status never writes the index.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { GitProvenancePort, GitSourceState, InProgressOperation, PortResult } from '../admission-ports.ts';

const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const IN_PROGRESS_MARKERS: readonly (readonly [InProgressOperation, string])[] = [
  ['MERGE', 'MERGE_HEAD'],
  ['CHERRY_PICK', 'CHERRY_PICK_HEAD'],
  ['REBASE', 'rebase-merge'],
  ['REBASE', 'rebase-apply'],
];

export interface GitSourceStateReaderDeps {
  /** Absolute path of the repository root (the directory that contains `study-1/`). */
  readonly repositoryRoot: string;
  /** The lockfile path relative to the repository root, for example `study-1/package-lock.json`. */
  readonly lockfilePath: string;
}

interface GitOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Reads the work tree's git state.
 *
 * @example
 * const git = new GitSourceStateReader({ repositoryRoot: '/repo', lockfilePath: 'study-1/package-lock.json' });
 * await git.readGitSourceState();
 */
export class GitSourceStateReader implements GitProvenancePort {
  readonly #root: string;
  readonly #lockfilePath: string;

  constructor(deps: GitSourceStateReaderDeps) {
    this.#root = deps.repositoryRoot;
    this.#lockfilePath = deps.lockfilePath;
  }

  async readGitSourceState(): PortResult<GitSourceState> {
    const status = await this.#git([
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ]);
    if (status.exitCode !== 0) {
      return { ok: false, error: { code: 'GIT_STATUS_FAILED', detail: status.stderr.slice(-2000) } };
    }
    const tree = await this.#git(['rev-parse', '--verify', '--quiet', 'HEAD^{tree}']);
    const tracked = await this.#git(['ls-files', '--error-unmatch', '--', this.#lockfilePath]);
    const lockfile = join(this.#root, this.#lockfilePath);
    return {
      ok: true,
      value: {
        status_porcelain_v2: status.stdout,
        ...(tree.exitCode === 0 ? { tree_sha: tree.stdout.trim() } : {}),
        in_progress: await this.#inProgress(),
        lockfile: {
          path: this.#lockfilePath,
          tracked: tracked.exitCode === 0,
          ...(existsSync(lockfile) ? { bytes: new Uint8Array(readFileSync(lockfile)) } : {}),
        },
      },
    };
  }

  async #inProgress(): Promise<readonly InProgressOperation[]> {
    const found: InProgressOperation[] = [];
    for (const [operation, marker] of IN_PROGRESS_MARKERS) {
      const located = await this.#git(['rev-parse', '--git-path', marker]);
      const path = located.stdout.trim();
      if (located.exitCode === 0 && existsSync(isAbsolute(path) ? path : join(this.#root, path))) {
        found.push(operation);
      }
    }
    return [...new Set(found)];
  }

  #git(args: readonly string[]): Promise<GitOutput> {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['-c', 'core.quotepath=off', ...args],
        {
          cwd: this.#root,
          encoding: 'utf8',
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 128;
          resolve({ exitCode: code, stdout, stderr: error !== null && stderr === '' ? error.message : stderr });
        },
      );
    });
  }
}
