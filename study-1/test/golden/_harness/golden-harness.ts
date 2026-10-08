// The golden harness every feature's golden tests use (design §12.4): load a case module and its
// committed fixture bytes, read records out of the fixture, and compare an actual result with the
// case's expected values. Golden tests read the committed bytes, never a fresh build: the
// reproducibility golden is what proves those bytes still follow from the case file.

import { fileURLToPath } from 'node:url';

import { NodeCaseModuleLoader } from '../../../tools/golden/lib/case-module-loader.ts';
import { decodeFixtureBundle } from '../../../tools/golden/lib/fixture-bundle.ts';
import { NodeFixtureFileSystem } from '../../../tools/golden/lib/fixture-file-system.ts';
import { boundedJsonText, boundedText, isJsonObject } from '../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import type { FixtureBytes } from '../../support/golden-builder/digest-links.ts';
import { locateCase } from '../../support/golden-builder/fixture-layout.ts';
import { parseFixtureRecords } from '../../support/golden-builder/fixture-integrity.ts';
import { parseGoldenCase } from '../../support/golden-builder/golden-case.ts';
import type { GoldenCase } from '../../support/golden-builder/golden-case.ts';
import { subjectDirectoryOf } from '../../support/golden-builder/scenario-builder.ts';

/** The study root: every case and fixture path is relative to it. */
export const STUDY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** A case with its committed fixture. */
export interface LoadedGoldenCase {
  readonly golden_case: GoldenCase;
  readonly case_file: string;
  readonly fixture_file: string;
  /** Package-relative path to committed bytes. */
  readonly files: FixtureBytes;
  /** `trials/<trial_id>` of the subject trial, or `probe`. */
  readonly subject_directory: string;
}

/**
 * Loads a case module (root-relative path) and its committed fixture; throws with every problem
 * when the case does not parse or its fixture is absent, empty or does not decode, which fails the
 * calling test.
 *
 * @example
 * const loaded = await loadGoldenCase('test/golden/trial-oracle/cases/control-pass.case.ts');
 */
export async function loadGoldenCase(caseFile: string, root: string = STUDY_ROOT): Promise<LoadedGoldenCase> {
  const location = locateCase(caseFile);
  if (location === undefined) {
    throw new Error(`${caseFile} is not <dir>/cases/<case-id>.case.ts; expected a case file path`);
  }
  const loaded = await new NodeCaseModuleLoader(root).load(caseFile);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const parsed = parseGoldenCase(loaded.value);
  if (!parsed.ok) {
    throw new Error(`${caseFile} does not parse:\n${parsed.error.join('\n')}`);
  }
  const stored = new NodeFixtureFileSystem(root).readFile(location.fixture_file);
  if (stored === undefined) {
    throw new Error(`${location.fixture_file} is absent; expected the committed fixture of ${caseFile}`);
  }
  const files = decodeFixtureBundle(stored);
  if (!files.ok) {
    throw new Error(`${location.fixture_file}: ${files.error}`);
  }
  if (files.value.size === 0) {
    throw new Error(`${location.fixture_file} holds no files; expected the committed fixture of ${caseFile}`);
  }
  return {
    golden_case: parsed.value,
    case_file: caseFile,
    fixture_file: location.fixture_file,
    files: files.value,
    subject_directory: subjectDirectoryOf(parsed.value.base),
  };
}

/**
 * The records of one fixture file, in file order; throws when the file is absent or a line is
 * not a JSON object (a broken fixture, not a finding).
 *
 * @example
 * fixtureRecords(loaded.files, `${loaded.subject_directory}/journals/caller-journal.jsonl`);
 */
export function fixtureRecords(files: FixtureBytes, path: string): readonly JsonObject[] {
  const bytes = files.get(path);
  if (bytes === undefined) {
    throw new Error(`the fixture has no ${path}; expected the file to exist`);
  }
  const parsed = parseFixtureRecords(new Map([[path, bytes]]));
  if (parsed.problems.length > 0) {
    throw new Error(parsed.problems.join('\n'));
  }
  return parsed.records.map((located) => located.record);
}

/**
 * Where `actual` departs from `expected`, as a partial match: every member an expected object
 * names must match, arrays match item by item and length, and scalars match exactly. Members the
 * expectation does not name are not compared. Iterative, and every value and path in a message is
 * rendered by the kernel's bounded helpers, so neither depth nor size can make it throw or flood
 * the report (Owner amendment A-05).
 *
 * @example
 * expectedMismatches({ verdict: 'pass' }, { verdict: 'fail', extra: 1 }); // ['$.verdict: expected "pass", got "fail"']
 */
export function expectedMismatches(expected: JsonValue, actual: JsonValue | undefined): readonly string[] {
  const mismatches: string[] = [];
  const pending: PendingComparison[] = [['$', expected, actual]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [at, want, got] = next;
    const step = compareStep(at, want, got);
    mismatches.push(...step.mismatches);
    pending.push(...step.children);
  }
  return mismatches.sort();
}

type PendingComparison = readonly [string, JsonValue, JsonValue | undefined];

// One level of the partial match: the mismatch found here, or the member comparisons to continue with.
function compareStep(
  at: string,
  want: JsonValue,
  got: JsonValue | undefined,
): { readonly mismatches: readonly string[]; readonly children: readonly PendingComparison[] } {
  if (Array.isArray(want)) {
    const items: readonly JsonValue[] = want;
    const gotItems: readonly JsonValue[] | undefined = Array.isArray(got) ? got : undefined;
    return gotItems?.length === items.length
      ? { mismatches: [], children: items.map((item, index) => [`${at}[${String(index)}]`, item, gotItems[index]]) }
      : {
          mismatches: [`${boundedText(at)}: expected an array of ${String(items.length)}, got ${shown(got)}`],
          children: [],
        };
  }
  if (isJsonObject(want)) {
    return isJsonObject(got)
      ? {
          mismatches: [],
          children: Object.entries(want).map(([key, value]) => [`${at}.${key}`, value, ownMember(got, key)]),
        }
      : { mismatches: [`${boundedText(at)}: expected an object, got ${shown(got)}`], children: [] };
  }
  return want === got
    ? { mismatches: [], children: [] }
    : { mismatches: [`${boundedText(at)}: expected ${shown(want)}, got ${shown(got)}`], children: [] };
}

// An absent actual value reads as `undefined`, as the case author would write it.
function shown(value: JsonValue | undefined): string {
  return value === undefined ? 'undefined' : boundedJsonText(value);
}

function ownMember(object: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}
