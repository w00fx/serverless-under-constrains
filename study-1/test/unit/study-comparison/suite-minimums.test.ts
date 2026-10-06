// The study-comparison suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the file
// exists and holds at least the §14 case count of every suite this feature has. §14 traces seven
// golden cases here: AC-RUA-009 (two), AC-RUA-012 and AC-RUA-027 (one each), AC-RUA-038 (one) and
// AC-RUA-050 (two); the fuzz floor holds the A-05 reading properties and the derivation properties.
//
// Values only ratchet upward (A-03), so the test pins the first counts as a floor: a downward edit
// of the committed file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/study-comparison.json', import.meta.url));
const golden = (file: string): string =>
  fileURLToPath(new URL(`../../golden/study-comparison/${file}`, import.meta.url));
const AC_CASE_FILES = [
  {
    file: golden('equality-projections.golden.test.ts'),
    cases: ['ac009-all-projections-equal', 'ac009-undeclared-difference'],
  },
  {
    file: golden('run-summary.golden.test.ts'),
    cases: ['ac012-summary-includes-all-four', 'ac027-four-cell-completion'],
  },
  {
    file: golden('study-completion.golden.test.ts'),
    cases: ['recovered-run-not-complete'],
  },
  {
    file: golden('operational-independence.golden.test.ts'),
    cases: ['cleanup-failure-without-compromise', 'leak-capable-of-correlated-effects'],
  },
] as const;
/**
 * The WP-16 counts after its single-pass review: two equality unit tests (design §8.14 declarable
 * projections) and eight golden tests checking the frozen oracle results against the trial oracle.
 */
const RATIFIED_FLOOR = { unit: 128, golden: 15, fuzz: 13 } as const;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('study-comparison suite minimums', () => {
  it('hold at least the §14 golden cases of AC-RUA-009, -012, -027, -038 and -050', () => {
    const counts = minimums();
    assert.ok((counts.golden ?? 0) >= 7, `golden minimum ${String(counts.golden)}; expected >= 7`);
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

  it('keep the §14 golden cases in their case files', () => {
    for (const { file, cases } of AC_CASE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const name of cases) {
        assert.ok(source.includes(`it('${name}',`), `case ${name} missing from ${file}`);
      }
    }
  });
});
