// A real git repository in a temporary directory with a miniature `study-1/` project: a source
// file, the lockfile and an ignored directory, committed on `main`. It is a harness over the real
// file system and git, not a fake: `GitSourceStateReader` runs against it unchanged, and the
// FakeGitRepository conformance test drives it into the states the fake scripts.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GIT_SETTINGS = [
  '-c',
  'user.name=Study Operator',
  '-c',
  'user.email=operator@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

export const WORK_TREE_LOCKFILE = 'study-1/package-lock.json';
export const WORK_TREE_SOURCE = 'study-1/src/refund.ts';
export const WORK_TREE_LOCKFILE_TEXT = '{"name":"study-1","lockfileVersion":3}\n';

/**
 * A committed miniature work tree.
 *
 * @example
 * const tree = TemporaryGitWorkTree.create();
 * tree.write('study-1/notes.txt', 'x');
 * tree.dispose();
 */
export class TemporaryGitWorkTree {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /** Creates the repository and commits the project on `main`. */
  static create(): TemporaryGitWorkTree {
    const tree = new TemporaryGitWorkTree(mkdtempSync(join(tmpdir(), 'rua-admission-git-')));
    tree.git(['init', '--quiet', '--initial-branch=main']);
    tree.write('.gitignore', 'study-1/ignored/\n');
    tree.write(WORK_TREE_SOURCE, 'export const refund = 1;\n');
    tree.write(WORK_TREE_LOCKFILE, WORK_TREE_LOCKFILE_TEXT);
    tree.commit('initial project');
    return tree;
  }

  /** Writes a file below the root (not committed). */
  write(path: string, content: string): void {
    const target = join(this.root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  /** Deletes a file below the root. */
  remove(path: string): void {
    rmSync(join(this.root, path), { force: true });
  }

  /** Stages everything and commits it. */
  commit(message: string): void {
    this.git(['add', '--all']);
    this.git(['commit', '--quiet', '--allow-empty', '-m', message]);
  }

  /** The commit id of HEAD. */
  head(): string {
    return this.git(['rev-parse', 'HEAD']).trim();
  }

  /** The tree id of HEAD. */
  tree(): string {
    return this.git(['rev-parse', 'HEAD^{tree}']).trim();
  }

  /** Runs git in the repository and returns its standard output. */
  git(args: readonly string[]): string {
    return execFileSync('git', [...GIT_SETTINGS, ...args], { cwd: this.root, encoding: 'utf8' });
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
