// The variant-validation suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the file
// exists and holds at least the §14 case count of every suite this feature has. §14 traces five
// golden case files here: AC-RUA-025 (two cases), AC-RUA-026 (three), AC-RUA-035 (one), AC-RUA-036
// (two) and AC-RUA-037 (three), eleven in all; the fuzz floor holds the A-11 properties.
//
// Values only ratchet upward (A-03), so the test pins the first counts as a floor: a downward edit
// of the committed file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../quality/suite-minimums/variant-validation.json', import.meta.url),
);

function goldenFile(name: string): string {
  return fileURLToPath(new URL(`../../golden/variant-validation/${name}`, import.meta.url));
}

/** Design §14 rows 025, 026, 035, 036 and 037: each case id, in the file that must hold it. */
const AC_CASE_FILES = [
  { file: goldenFile('verified.golden.test.ts'), cases: ['treatment-pass', 'treatment-fail'] },
  {
    file: goldenFile('operational-recovery.golden.test.ts'),
    cases: ['cleanup-repaired', 'audit-repaired', 'lease-repaired'],
  },
  { file: goldenFile('failed.golden.test.ts'), cases: ['trustworthy-control-fail'] },
  {
    file: goldenFile('indeterminate.golden.test.ts'),
    cases: ['scientific-indeterminate', 'operational-indeterminate'],
  },
  {
    file: goldenFile('not-repairable.golden.test.ts'),
    cases: ['missing-scientific-evidence', 'invalid-admission-or-fidelity', 'manifest-drift'],
  },
] as const;
/** The WP-17 counts at first delivery. */
const RATIFIED_FLOOR = { unit: 121, golden: 11, fuzz: 6 } as const;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('variant-validation suite minimums', () => {
  it('hold at least the eleven §14 golden cases and one fuzz property', () => {
    const counts = minimums();
    assert.ok((counts.golden ?? 0) >= 11, `golden minimum ${String(counts.golden)}; expected >= 11`);
    assert.ok((counts.fuzz ?? 0) >= 1, `fuzz minimum ${String(counts.fuzz)}; expected >= 1`);
  });

  it('never fall below the ratified counts (they only ratchet upward)', () => {
    const counts = minimums();
    for (const suite of ['unit', 'golden', 'fuzz'] as const) {
      assert.ok(
        (counts[suite] ?? 0) >= RATIFIED_FLOOR[suite],
        `${suite} minimum ${String(counts[suite])}; expected >= ${String(RATIFIED_FLOOR[suite])}`,
      );
    }
  });

  it('keep the §14 case ids in their golden files', () => {
    for (const { file, cases } of AC_CASE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const name of cases) {
        assert.ok(source.includes(`'${name}'`), `case ${name} missing from ${file}`);
      }
    }
  });
});
