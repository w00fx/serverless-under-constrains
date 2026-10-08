// The in-memory emulator of the fixture generator's file-system port. It answers the same
// questions as `NodeFixtureFileSystem` over a map of root-relative POSIX paths: the case-file and
// fixture-entry globs are matched by their equivalent regular expressions, and a directory exists
// exactly when some file lies below it. The shared conformance suite holds it to the
// binding's behavior (`fixture-file-system-conformance.ts`).

import type { FixtureFileSystem } from '../../../tools/golden/lib/fixture-file-system.ts';

// `test/golden/**/cases/*.case.ts` and `test/golden/**/fixtures/*`, with `**` as zero or more segments.
const CASE_FILE_PATH = /^test\/golden\/(?:[^/]+\/)*cases\/[^/]+\.case\.ts$/;
const FIXTURE_ENTRY_PATH = /^test\/golden\/(?:[^/]+\/)*fixtures\/[^/]+$/;

/**
 * A fixture file system held in memory; `files` seeds it with root-relative paths.
 *
 * @example
 * const files = new MemoryFixtureFileSystem(new Map([['test/golden/x/cases/a.case.ts', bytes]]));
 * files.findCaseFiles(); // ['test/golden/x/cases/a.case.ts']
 */
export class MemoryFixtureFileSystem implements FixtureFileSystem {
  readonly #files = new Map<string, Uint8Array>();

  constructor(files: ReadonlyMap<string, Uint8Array> = new Map()) {
    for (const [path, bytes] of files) {
      this.#files.set(path, Uint8Array.from(bytes));
    }
  }

  /**
   * Case files, sorted.
   *
   * @example
   * files.findCaseFiles(); // ['test/golden/x/cases/a.case.ts']
   */
  findCaseFiles(): readonly string[] {
    return this.#paths().filter((path) => CASE_FILE_PATH.test(path));
  }

  /**
   * Files and directories that match the fixture-entry glob, sorted.
   *
   * @example
   * files.findFixtureEntries(); // ['test/golden/x/fixtures/a.fixture.json']
   */
  findFixtureEntries(): readonly string[] {
    const entries = new Set(this.#paths().flatMap((path) => [...directoriesOf(path), path]));
    return [...entries].filter((entry) => FIXTURE_ENTRY_PATH.test(entry)).sort();
  }

  /**
   * A copy of a file's bytes, or undefined.
   *
   * @example
   * files.readFile('test/golden/x/fixtures/a.fixture.json');
   */
  readFile(path: string): Uint8Array | undefined {
    const bytes = this.#files.get(path);
    return bytes === undefined ? undefined : Uint8Array.from(bytes);
  }

  /**
   * Stores a copy of the bytes, replacing any earlier file at the path.
   *
   * @example
   * files.writeFile('test/golden/x/fixtures/a.fixture.json', bytes);
   */
  writeFile(path: string, bytes: Uint8Array): void {
    this.#files.set(path, Uint8Array.from(bytes));
  }

  #paths(): readonly string[] {
    return [...this.#files.keys()].sort();
  }
}

// Every proper ancestor directory of a file path: `a/b/c.json` → `a`, `a/b`.
function directoriesOf(path: string): readonly string[] {
  const segments = path.split('/').slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}
