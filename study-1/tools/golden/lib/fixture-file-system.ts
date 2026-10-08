// The file-system port of the golden fixture generator, and its local binding. Every path is
// POSIX and relative to the study root the generator runs in, so the in-memory fake and the
// binding answer the same questions with the same paths.

import { globSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { CASE_FILE_GLOB } from '../../../test/support/golden-builder/fixture-layout.ts';

/** Every entry a fixture could be, or that could shadow one: anything directly under `fixtures/`. */
export const FIXTURE_ENTRY_GLOB = 'test/golden/**/fixtures/*';

/** What the generator needs from the files under the study root. */
export interface FixtureFileSystem {
  /** Case files matching `test/golden/**\/cases/*.case.ts`, sorted. */
  findCaseFiles(): readonly string[];
  /** Files and directories matching `test/golden/**\/fixtures/*`, sorted. */
  findFixtureEntries(): readonly string[];
  /** The bytes of a file, or undefined when it does not exist. */
  readFile(path: string): Uint8Array | undefined;
  /** Writes a file, creating its parent directories. */
  writeFile(path: string, bytes: Uint8Array): void;
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
   * Entries directly under a `fixtures/` directory, files and directories alike.
   *
   * @example
   * files.findFixtureEntries(); // ['test/golden/_harness/fixtures/base-probe.fixture.json', ...]
   */
  findFixtureEntries(): readonly string[] {
    return this.#glob(FIXTURE_ENTRY_GLOB);
  }

  /**
   * A file's bytes, or undefined.
   *
   * @example
   * files.readFile('test/golden/_harness/fixtures/base-probe.fixture.json');
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
   * files.writeFile('test/golden/x/fixtures/c.fixture.json', bytes);
   */
  writeFile(path: string, bytes: Uint8Array): void {
    const target = join(this.#root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
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
