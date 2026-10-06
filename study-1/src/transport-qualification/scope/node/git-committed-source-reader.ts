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
  /** Git's stderr, or the spawn error message when git never ran (missing binary or directory). */
  readonly stderr: string;
}

/** One `git ls-tree -z` entry: `<mode> SP <type> SP <object> TAB <path>`. */
const LS_TREE_ENTRY = /^[0-7]+ (\w+) ([0-9a-f]+)\t(.*)$/s;

/**
 * The production `CommittedSourceReader`. Only a confirmed "the revision's tree has no file at
 * this path" reads as `undefined`; every operational failure (no git, no repository, a bad
 * revision, an unreadable object, an oversized output) rejects with git's exit status and
 * stderr, so it can never pass for "not committed".
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
    // `git ls-tree` without a pathspec lists the whole tree; no root means no file.
    if (roots.length === 0) {
      return [];
    }
    const output = await this.#gitOrThrow(['ls-tree', '-r', '-z', '--name-only', this.#revision, '--', ...roots]);
    return splitNul(output.stdout).sort();
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    // Listing the single path first separates "absent at the revision" (an empty listing, exit
    // 0) from a failure, without parsing git's localized error text.
    const listing = await this.#gitOrThrow(['ls-tree', '-z', this.#revision, '--', path]);
    const object = blobObject(splitNul(listing.stdout), path);
    if (object === undefined) {
      return undefined;
    }
    const content = await this.#gitOrThrow(['cat-file', 'blob', object]);
    return new Uint8Array(content.stdout);
  }

  async #gitOrThrow(args: readonly string[]): Promise<GitOutput> {
    const output = await this.#git(args);
    if (output.exitCode !== 0) {
      throw new Error(
        `git ${String(args[0])} ${this.#revision} in ${this.#projectRoot} exited ${String(output.exitCode)}: ` +
          `${output.stderr.trim()}; expected a git work tree with that revision`,
      );
    }
    return output;
  }

  #git(args: readonly string[]): Promise<GitOutput> {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['--literal-pathspecs', ...args],
        { cwd: this.#projectRoot, encoding: 'buffer', maxBuffer: GIT_MAX_BUFFER_BYTES },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ exitCode: 0, stdout, stderr: stderr.toString('utf8') });
            return;
          }
          const exitCode = typeof error.code === 'number' ? error.code : 1;
          const detail = stderr.length > 0 ? stderr.toString('utf8') : error.message;
          resolve({ exitCode, stdout, stderr: detail });
        },
      );
    });
  }
}

// The object id of the one blob listed exactly at `path`; a directory (a tree, or several
// entries), a submodule or another path is no committed file.
function blobObject(entries: readonly string[], path: string): string | undefined {
  const [entry, ...others] = entries;
  const match = entry === undefined || others.length > 0 ? null : LS_TREE_ENTRY.exec(entry);
  const [, type, object, listedPath] = match ?? [];
  return type === 'blob' && listedPath === path ? object : undefined;
}

function splitNul(stdout: Buffer): string[] {
  return stdout
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry !== '');
}
