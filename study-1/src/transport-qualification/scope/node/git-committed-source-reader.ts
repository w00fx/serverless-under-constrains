// Reads committed source through git (BR-RUA-028 "recomputes the selected scope against
// current committed source"): files are listed from the revision's tree and read from its
// blobs, never from the working tree, so an uncommitted edit can neither enter nor hide from
// the scope. Paths are relative to the project root, which may be a subdirectory of the
// repository (the study lives in `study-1/`).

import { execFile } from 'node:child_process';

import type { CommittedSourceReader } from '../scope-recomputation.ts';

const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

export interface GitCommittedSourceReaderDeps {
  /** Absolute path of the project root inside a git work tree. */
  readonly projectRoot: string;
  /** The revision to read; defaults to `HEAD`. */
  readonly revision?: string;
}

interface GitOutput {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * The production `CommittedSourceReader`.
 *
 * @example
 * const sources = new GitCommittedSourceReader({ projectRoot: '/repo/study-1' });
 * const files = await sources.listFiles(['src/provider-client']);
 */
export class GitCommittedSourceReader implements CommittedSourceReader {
  readonly #projectRoot: string;
  readonly #revision: string;

  constructor(deps: GitCommittedSourceReaderDeps) {
    this.#projectRoot = deps.projectRoot;
    this.#revision = deps.revision ?? 'HEAD';
  }

  async listFiles(roots: readonly string[]): Promise<readonly string[]> {
    const output = await this.#git(['ls-tree', '-r', '-z', '--name-only', this.#revision, '--', ...roots]);
    if (output.exitCode !== 0) {
      throw new Error(
        `git ls-tree ${this.#revision} in ${this.#projectRoot} exited ${String(output.exitCode)}: ${output.stderr.trim()}; ` +
          'expected a git work tree with that revision',
      );
    }
    return output.stdout
      .toString('utf8')
      .split('\0')
      .filter((path) => path !== '')
      .sort();
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    const output = await this.#git(['cat-file', 'blob', `${this.#revision}:./${path}`]);
    return output.exitCode === 0 ? new Uint8Array(output.stdout) : undefined;
  }

  #git(args: readonly string[]): Promise<GitOutput> {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['--literal-pathspecs', ...args],
        { cwd: this.#projectRoot, encoding: 'buffer', maxBuffer: GIT_MAX_BUFFER_BYTES },
        (error, stdout, stderr) => {
          const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({ exitCode, stdout, stderr: stderr.toString('utf8') });
        },
      );
    });
  }
}
