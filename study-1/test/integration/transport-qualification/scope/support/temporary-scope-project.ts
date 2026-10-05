// A real git repository in a temporary directory holding a miniature Study 1 project under
// `study-1/` (the project root is a subdirectory, as in this repository). `node_modules/` is
// installed on disk but ignored by git, like a real `npm ci`. This is a harness over the real
// file system and git, not a fake: the scope adapters run against it unchanged.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GIT_IDENTITY = [
  '-c',
  'user.name=Scope Fixture',
  '-c',
  'user.email=scope-fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
];

export class TemporaryScopeProject {
  readonly repositoryRoot: string;
  readonly projectRoot: string;

  private constructor(repositoryRoot: string) {
    this.repositoryRoot = repositoryRoot;
    this.projectRoot = join(repositoryRoot, 'study-1');
  }

  /** Creates the repository, writes the files under the project root and commits them. */
  static create(files: Readonly<Record<string, string>>): TemporaryScopeProject {
    const project = new TemporaryScopeProject(mkdtempSync(join(tmpdir(), 'rua-scope-')));
    mkdirSync(project.projectRoot, { recursive: true });
    project.#git(['init', '--quiet', '--initial-branch=main']);
    for (const [path, content] of Object.entries(files)) {
      project.write(path, content);
    }
    project.commit('initial project');
    return project;
  }

  /** Writes a file below the project root (not committed). */
  write(path: string, content: string): void {
    const target = join(this.projectRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  /** Installs a package under `node_modules/` (ignored by git). */
  installPackage(name: string, version: string, source: string): void {
    this.write(
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, version, type: 'module', main: 'index.js' }),
    );
    this.write(`node_modules/${name}/index.js`, source);
  }

  /** Stages every change in the work tree and commits it. */
  commit(message: string): void {
    this.#git(['add', '--all']);
    this.#git([...GIT_IDENTITY, 'commit', '--quiet', '--allow-empty', '-m', message]);
  }

  /** The commit id of HEAD. */
  head(): string {
    return this.#git(['rev-parse', 'HEAD']).trim();
  }

  dispose(): void {
    rmSync(this.repositoryRoot, { recursive: true, force: true });
  }

  #git(args: readonly string[]): string {
    return execFileSync('git', [...args], { cwd: this.repositoryRoot, encoding: 'utf8' });
  }
}
