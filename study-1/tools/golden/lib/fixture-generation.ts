// Golden fixture generation and its byte-for-byte check (design §12.4). Every case is loaded,
// parsed, materialized and bundled in memory; `--check` compares the bundle with the committed
// fixture file and reports a missing or differing fixture, every missing, extra or differing file
// inside it, and every entry under `fixtures/` without a case. Writing creates a missing fixture
// only: committed fixtures are truth-layer material, so replacing one needs an explicit
// `--overwrite <case-id>` (`.claude/rules/truth-layer.md`).

import { boundedJsonText } from '../../../src/record-contract/json-value.ts';
import type { FixtureBytes } from '../../../test/support/golden-builder/digest-links.ts';
import { locateCase } from '../../../test/support/golden-builder/fixture-layout.ts';
import { materializeCase } from '../../../test/support/golden-builder/fixture-materializer.ts';
import { parseGoldenCase } from '../../../test/support/golden-builder/golden-case.ts';
import type { CaseModuleLoader } from './case-module-loader.ts';
import { decodeFixtureBundle, encodeFixtureBundle } from './fixture-bundle.ts';
import type { FixtureFileSystem } from './fixture-file-system.ts';

/** One case's fixture, regenerated in memory. */
export interface GeneratedFixture {
  readonly case_file: string;
  readonly case_id: string;
  readonly fixture_file: string;
  readonly files: FixtureBytes;
  /** The committed form of `files`: their canonical bundle. */
  readonly bundle: Uint8Array;
}

/** What regenerating every case produced: the fixtures, and the problems of the cases that failed. */
export interface GenerationReport {
  readonly fixtures: readonly GeneratedFixture[];
  readonly problems: readonly string[];
}

/** One way a committed fixture differs from its regeneration. */
export interface FixtureDiscrepancy {
  readonly kind: 'missing' | 'extra' | 'different';
  /** Root-relative path of the fixture file, then `#` and the file inside it when one file differs. */
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
        `case_id ${boundedJsonText(parsed.value.case_id)}; expected the file name's ${boundedJsonText(location.case_id)}`,
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
      fixture_file: location.fixture_file,
      files: files.value,
      bundle: encodeFixtureBundle(files.value),
    },
  };
}

/**
 * Every difference between a regenerated fixture and the committed fixture file: the file itself
 * when it is missing, does not decode, or holds the same files in other bytes; otherwise each
 * missing, extra or differing file inside it.
 *
 * @example
 * compareFixture(files, fixture); // [] when the committed fixture is reproduced exactly
 */
export function compareFixture(files: FixtureFileSystem, fixture: GeneratedFixture): readonly FixtureDiscrepancy[] {
  const stored = files.readFile(fixture.fixture_file);
  if (stored === undefined) {
    return [{ kind: 'missing', path: fixture.fixture_file }];
  }
  if (sameBytes(stored, fixture.bundle)) {
    return [];
  }
  const committed = decodeFixtureBundle(stored);
  const discrepancies = committed.ok ? memberDiscrepancies(fixture, committed.value) : [];
  return discrepancies.length > 0 ? discrepancies : [{ kind: 'different', path: fixture.fixture_file }];
}

// The files of a decoded committed fixture that differ from the regeneration, in path order.
function memberDiscrepancies(fixture: GeneratedFixture, committed: FixtureBytes): readonly FixtureDiscrepancy[] {
  const discrepancies: FixtureDiscrepancy[] = [];
  for (const [relative, bytes] of [...fixture.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const path = `${fixture.fixture_file}#${relative}`;
    const stored = committed.get(relative);
    if (stored === undefined) {
      discrepancies.push({ kind: 'missing', path });
    } else if (!sameBytes(stored, bytes)) {
      discrepancies.push({ kind: 'different', path });
    }
  }
  for (const relative of committed.keys()) {
    if (!fixture.files.has(relative)) {
      discrepancies.push({ kind: 'extra', path: `${fixture.fixture_file}#${relative}` });
    }
  }
  return discrepancies;
}

/**
 * Entries under `fixtures/` that are not the fixture file of a regenerated case: a fixture whose
 * case is gone or fails, and any other file or directory there.
 *
 * @example
 * orphanFixtures(files, report.fixtures); // ['test/golden/x/fixtures/deleted-case.fixture.json']
 */
export function orphanFixtures(files: FixtureFileSystem, fixtures: readonly GeneratedFixture[]): readonly string[] {
  const owned = new Set(fixtures.map((fixture) => fixture.fixture_file));
  return files.findFixtureEntries().filter((entry) => !owned.has(entry));
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
  const stored = files.readFile(fixture.fixture_file);
  if (stored !== undefined && sameBytes(stored, fixture.bundle)) {
    return 'unchanged';
  }
  if (stored !== undefined && !overwrite) {
    return 'refused';
  }
  files.writeFile(fixture.fixture_file, fixture.bundle);
  return stored === undefined ? 'written' : 'overwritten';
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
