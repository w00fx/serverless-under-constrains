// The file-system port of the golden fixture generator, and its local binding. Every path is
// POSIX and relative to the study root the generator runs in, so the in-memory fake and the
// binding answer the same questions with the same paths.

import { globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { CASE_FILE_GLOB } from '../../../test/support/golden-builder/fixture-layout.ts';

/** Every fixture directory a case could own: `fixtures/<case-id>` under `test/golden/`. */
export const FIXTURE_DIRECTORY_GLOB = 'test/golden/**/fixtures/*';

/** What the generator needs from the files under the study root. */
export interface FixtureFileSystem {
  /** Case files matching `test/golden/**\/cases/*.case.ts`, sorted. */
  findCaseFiles(): readonly string[];
  /** Directories matching `test/golden/**\/fixtures/*`, sorted. */
  findFixtureDirectories(): readonly string[];
  /** Every file below `directory`, as sorted paths relative to it; empty when it is absent. */
  listFiles(directory: string): readonly string[];
  /** The bytes of a file, or undefined when it does not exist. */
  readFile(path: string): Uint8Array | undefined;
  /** Writes a file, creating its parent directories. */
  writeFile(path: string, bytes: Uint8Array): void;
  /** Deletes a file; deleting an absent file does nothing. */
  deleteFile(path: string): void;
}

/**
 * The local binding of `FixtureFileSystem`, rooted at `root`.
 *
 * @example
 * const files = new NodeFixtureFileSystem(process.cwd());
 * files.findCaseFiles(); // ['test/golden/trial-oracle/cases/control-pass.case.ts', ...]
 */
export class NodeFixtureFileSystem implements FixtureFileSystem {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  /**
   * Case files under the root.
   *
   * @example
   * files.findCaseFiles();
   */
  findCaseFiles(): readonly string[] {
    return this.#glob(CASE_FILE_GLOB).filter((path) => this.#isFile(path));
  }

  /**
   * Fixture directories under the root.
   *
   * @example
   * files.findFixtureDirectories(); // ['test/golden/_harness/fixtures/base-probe', ...]
   */
  findFixtureDirectories(): readonly string[] {
    return this.#glob(FIXTURE_DIRECTORY_GLOB).filter((path) => !this.#isFile(path));
  }

  /**
   * Files below a directory, relative to it.
   *
   * @example
   * files.listFiles('test/golden/_harness/fixtures/base-probe'); // ['admission/execution-manifest.json', ...]
   */
  listFiles(directory: string): readonly string[] {
    return this.#glob(`${directory}/**/*`)
      .filter((path) => this.#isFile(path))
      .map((path) => path.slice(directory.length + 1));
  }

  /**
   * A file's bytes, or undefined.
   *
   * @example
   * files.readFile('test/golden/_harness/fixtures/base-probe/runner/runner-journal.jsonl');
   */
  readFile(path: string): Uint8Array | undefined {
    if (!this.#isFile(path)) {
      return undefined;
    }
    return new Uint8Array(readFileSync(join(this.#root, path)));
  }

  /**
   * Writes a file and its parent directories.
   *
   * @example
   * files.writeFile('test/golden/x/fixtures/c/a.json', bytes);
   */
  writeFile(path: string, bytes: Uint8Array): void {
    const target = join(this.#root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }

  /**
   * Deletes a file if it exists.
   *
   * @example
   * files.deleteFile('test/golden/x/fixtures/c/stale.json');
   */
  deleteFile(path: string): void {
    rmSync(join(this.#root, path), { force: true });
  }

  #glob(pattern: string): readonly string[] {
    return globSync(pattern, { cwd: this.#root })
      .map((path) => path.split(sep).join('/'))
      .sort();
  }

  #isFile(path: string): boolean {
    return statSync(join(this.#root, path), { throwIfNoEntry: false })?.isFile() ?? false;
  }
}
