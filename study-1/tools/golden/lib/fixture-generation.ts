// Golden fixture generation and its byte-for-byte check (design §12.4). Every case is loaded,
// parsed and materialized in memory; `--check` compares the result with the committed fixture and
// reports every missing, extra or differing file and every fixture directory without a case.
// Writing creates a missing fixture only: committed fixtures are truth-layer material, so
// replacing one needs an explicit `--overwrite <case-id>` (`.claude/rules/truth-layer.md`).
//
// The generator manages the golden directories of the design §5.1 layout
// `test/golden/<feature>/{cases/*.case.ts, fixtures/<case-id>/**}`: a directory with at least one
// case file. A fixture directory there without its case is an orphan. A fixture directory in a
// golden directory with no case file at all was written by hand (the WP-13 evidence-index tree
// of d24f678, whose expected digests were computed with `shasum`); the generator neither writes
// nor checks it, and lists it in its report instead of failing on it (WP-09 single-pass review).

import type { FixtureBytes } from '../../../test/support/golden-builder/digest-links.ts';
import { locateCase } from '../../../test/support/golden-builder/fixture-layout.ts';
import { materializeCase } from '../../../test/support/golden-builder/fixture-materializer.ts';
import { parseGoldenCase } from '../../../test/support/golden-builder/golden-case.ts';
import type { CaseModuleLoader } from './case-module-loader.ts';
import type { FixtureFileSystem } from './fixture-file-system.ts';

/** One case's fixture, regenerated in memory. */
export interface GeneratedFixture {
  readonly case_file: string;
  readonly case_id: string;
  readonly fixture_directory: string;
  readonly files: FixtureBytes;
}

/** What regenerating every case produced: the fixtures, and the problems of the cases that failed. */
export interface GenerationReport {
  readonly fixtures: readonly GeneratedFixture[];
  readonly problems: readonly string[];
}

/** One way a committed fixture differs from its regeneration. */
export interface FixtureDiscrepancy {
  readonly kind: 'missing' | 'extra' | 'different';
  /** Root-relative path of the file. */
  readonly path: string;
}

/** How writing one fixture ended. */
export type FixtureWriteOutcome = 'written' | 'unchanged' | 'overwritten' | 'refused';

/**
 * Loads, parses and materializes every case file; a case that fails is reported and skipped.
 *
 * @example
 * const report = await generateFixtures(files.findCaseFiles(), new NodeCaseModuleLoader(root));
 */
export async function generateFixtures(
  caseFiles: readonly string[],
  loader: CaseModuleLoader,
): Promise<GenerationReport> {
  const fixtures: GeneratedFixture[] = [];
  const problems: string[] = [];
  for (const caseFile of caseFiles) {
    const generated = await generateOne(caseFile, loader);
    if (generated.ok) {
      fixtures.push(generated.value);
    } else {
      problems.push(...generated.error.map((problem) => `${caseFile}: ${problem}`));
    }
  }
  return { fixtures, problems };
}

async function generateOne(
  caseFile: string,
  loader: CaseModuleLoader,
): Promise<
  { readonly ok: true; readonly value: GeneratedFixture } | { readonly ok: false; readonly error: readonly string[] }
> {
  const location = locateCase(caseFile);
  if (location === undefined) {
    return { ok: false, error: ['the path is not <dir>/cases/<case-id>.case.ts; expected a case file'] };
  }
  const loaded = await loader.load(caseFile);
  if (!loaded.ok) {
    return { ok: false, error: [loaded.error] };
  }
  const parsed = parseGoldenCase(loaded.value);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value.case_id !== location.case_id) {
    return {
      ok: false,
      error: [
        `case_id ${JSON.stringify(parsed.value.case_id)}; expected the file name's ${JSON.stringify(location.case_id)}`,
      ],
    };
  }
  const files = materializeCase(parsed.value);
  if (!files.ok) {
    return files;
  }
  return {
    ok: true,
    value: {
      case_file: caseFile,
      case_id: location.case_id,
      fixture_directory: location.fixture_directory,
      files: files.value,
    },
  };
}

/**
 * Every difference between a regenerated fixture and the committed bytes.
 *
 * @example
 * compareFixture(files, fixture); // [] when the committed fixture is reproduced exactly
 */
export function compareFixture(files: FixtureFileSystem, fixture: GeneratedFixture): readonly FixtureDiscrepancy[] {
  const committed = new Set(files.listFiles(fixture.fixture_directory));
  const discrepancies: FixtureDiscrepancy[] = [];
  for (const [relative, bytes] of [...fixture.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const path = `${fixture.fixture_directory}/${relative}`;
    const stored = files.readFile(path);
    if (stored === undefined) {
      discrepancies.push({ kind: 'missing', path });
    } else if (!sameBytes(stored, bytes)) {
      discrepancies.push({ kind: 'different', path });
    }
  }
  for (const relative of committed) {
    if (!fixture.files.has(relative)) {
      discrepancies.push({ kind: 'extra', path: `${fixture.fixture_directory}/${relative}` });
    }
  }
  return discrepancies;
}

/**
 * Fixture directories that no regenerated case owns, in the golden directories that hold case
 * files. A case that failed to load still marks its golden directory as managed.
 *
 * @example
 * orphanFixtureDirectories(files, report.fixtures); // ['test/golden/x/fixtures/deleted-case']
 */
export function orphanFixtureDirectories(
  files: FixtureFileSystem,
  fixtures: readonly GeneratedFixture[],
): readonly string[] {
  const owned = new Set(fixtures.map((fixture) => fixture.fixture_directory));
  const managed = managedGoldenDirectories(files);
  return files
    .findFixtureDirectories()
    .filter((directory) => !owned.has(directory) && managed.has(goldenDirectoryBefore(directory, 'fixtures')));
}

/**
 * Fixture directories in golden directories without any case file: hand-written evidence the
 * generator neither writes nor checks, listed so a report never hides them.
 *
 * @example
 * handAuthoredFixtureDirectories(files); // ['test/golden/evidence-package/fixtures/durable-run-trial']
 */
export function handAuthoredFixtureDirectories(files: FixtureFileSystem): readonly string[] {
  const managed = managedGoldenDirectories(files);
  return files
    .findFixtureDirectories()
    .filter((directory) => !managed.has(goldenDirectoryBefore(directory, 'fixtures')));
}

function managedGoldenDirectories(files: FixtureFileSystem): ReadonlySet<string> {
  return new Set(files.findCaseFiles().map((caseFile) => goldenDirectoryBefore(caseFile, 'cases')));
}

// The directory holding `cases/` and `fixtures/`: `test/golden/x/cases/a.case.ts` and
// `test/golden/x/fixtures/a` -> `test/golden/x/`. The ports return only paths of that layout, and
// neither a case file name nor a fixture name holds a `/`, so the last `/<segment>/` is the layout's.
function goldenDirectoryBefore(path: string, segment: 'cases' | 'fixtures'): string {
  return path.slice(0, path.lastIndexOf(`/${segment}/`) + 1);
}

/**
 * Writes a fixture that does not exist yet; replaces a differing one only when `overwrite`.
 *
 * @example
 * writeFixture(files, fixture, overwriteIds.has(fixture.case_id)); // 'written' for a new case
 */
export function writeFixture(
  files: FixtureFileSystem,
  fixture: GeneratedFixture,
  overwrite: boolean,
): FixtureWriteOutcome {
  const discrepancies = compareFixture(files, fixture);
  if (discrepancies.length === 0) {
    return 'unchanged';
  }
  const fresh = files.listFiles(fixture.fixture_directory).length === 0;
  if (!fresh && !overwrite) {
    return 'refused';
  }
  for (const discrepancy of discrepancies.filter((item) => item.kind === 'extra')) {
    files.deleteFile(discrepancy.path);
  }
  for (const [relative, bytes] of fixture.files) {
    files.writeFile(`${fixture.fixture_directory}/${relative}`, bytes);
  }
  return fresh ? 'written' : 'overwritten';
}

/**
 * Byte equality of two buffers.
 *
 * @example
 * sameBytes(Uint8Array.of(1), Uint8Array.of(1)); // true
 */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
