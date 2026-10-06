// The billing-amendment suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the file
// exists and holds at least the §14 case count of every suite this feature has. §14 traces two unit
// case files here: AC-RUA-024 (two cases) and AC-RUA-034 (three cases); the fuzz floor holds the
// design §12.5 `parseCurCsv` row properties.
//
// Values only ratchet upward (A-03), so the test pins the first counts as a floor: a downward edit
// of the committed file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/billing-amendment.json', import.meta.url));
const AC_CASE_FILES = [
  {
    file: fileURLToPath(new URL('./attributable-cost-compared.test.ts', import.meta.url)),
    cases: ['within-ceiling', 'above-ceiling'],
  },
  {
    file: fileURLToPath(new URL('./attributable-cost-unverified.test.ts', import.meta.url)),
    cases: ['incomplete-attribution', 'non-usd-line', 'mixed-currencies'],
  },
] as const;
/** The WP-18 counts at first delivery. */
const RATIFIED_FLOOR = { unit: 114, fuzz: 10 } as const;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('billing-amendment suite minimums', () => {
  it('hold at least the §14 AC-RUA-024 and AC-RUA-034 unit cases', () => {
    const counts = minimums();
    assert.ok((counts.unit ?? 0) >= 5, `unit minimum ${String(counts.unit)}; expected >= 5`);
    assert.ok((counts.fuzz ?? 0) >= 1, `fuzz minimum ${String(counts.fuzz)}; expected >= 1`);
  });

  it('never fall below the ratified counts (they only ratchet upward)', () => {
    const counts = minimums();
    for (const suite of ['unit', 'fuzz'] as const) {
      assert.ok(
        (counts[suite] ?? 0) >= RATIFIED_FLOOR[suite],
        `${suite} minimum ${String(counts[suite])}; expected >= ${String(RATIFIED_FLOOR[suite])}`,
      );
    }
  });

  it('keep the AC-RUA-024 and AC-RUA-034 cases §14 traces in their case files', () => {
    for (const { file, cases } of AC_CASE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const name of cases) {
        assert.ok(source.includes(`it('${name}',`), `case ${name} missing from ${file}`);
      }
    }
  });
});
