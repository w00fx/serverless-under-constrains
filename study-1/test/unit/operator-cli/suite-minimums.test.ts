// The operator-cli suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the file exists
// and holds at least the §14 case counts. §14 traces AC-RUA-055 to the revision-check cases of
// `oracle-revision-check.integration.test.ts` ("passes at a commit, then fails after a seeded
// regression commit"), and the e2e halves of AC-RUA-002, AC-RUA-021 and AC-RUA-027 to
// `ac002-real-probe` and `ac021-real-probe-pass` in `transport-probe.e2e.test.ts` and
// `ac027-canonical-run` in `canonical-run.e2e.test.ts`.
//
// Values only ratchet upward (A-03), so the test pins the counts as a floor: a downward edit of the
// committed file fails here. Raise both together (WP-28 review F1: the package had no guard).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/operator-cli.json', import.meta.url));
const testFile = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const AC_CASE_FILES = [
  {
    file: testFile('integration/operator-cli/oracle-revision-check.integration.test.ts'),
    cases: ['ac055-revision-check-passes-at-commit', 'ac055-revision-check-fails-after-seeded-regression'],
  },
  {
    file: testFile('e2e/transport-probe.e2e.test.ts'),
    cases: ['ac002-real-probe', 'ac021-real-probe-pass'],
  },
  {
    file: testFile('e2e/canonical-run.e2e.test.ts'),
    cases: ['ac027-canonical-run'],
  },
] as const;
/** The WP-28 single-pass review, ratcheted up from the delivery's 182 unit cases. */
const RATIFIED_FLOOR = { unit: 195, integration: 77, fuzz: 12, e2e: 3 } as const;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('operator-cli suite minimums', () => {
  it('hold at least the §14 AC-RUA-055 integration and AC-002, -021, -027 e2e cases', () => {
    const counts = minimums();
    assert.ok((counts.integration ?? 0) >= 2, `integration minimum ${String(counts.integration)}; expected >= 2`);
    assert.ok((counts.e2e ?? 0) >= 3, `e2e minimum ${String(counts.e2e)}; expected >= 3`);
  });

  it('never fall below the ratified counts (they only ratchet upward)', () => {
    const counts = minimums();
    for (const suite of ['unit', 'integration', 'fuzz', 'e2e'] as const) {
      assert.ok(
        (counts[suite] ?? 0) >= RATIFIED_FLOOR[suite],
        `${suite} minimum ${String(counts[suite])}; expected >= ${String(RATIFIED_FLOOR[suite])}`,
      );
    }
  });

  it('keep the AC-RUA-055, -002, -021 and -027 cases §14 traces in their case files', () => {
    for (const { file, cases } of AC_CASE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const name of cases) {
        assert.ok(source.includes(`it('${name}',`), `case ${name} missing from ${file}`);
      }
    }
  });
});
