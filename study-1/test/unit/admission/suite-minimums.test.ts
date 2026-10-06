// The admission suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the file exists
// and holds at least the §14 case counts. §14 traces AC-RUA-014 to the eight cases of
// `pre-execution-rejection.integration.test.ts`, the AC-RUA-051 admission case to
// `qualification-drift-admission.integration.test.ts`, and AC-RUA-055 to the ORACLE_NOT_FINAL
// cases of `oracle-attestation.integration.test.ts`.
//
// Values only ratchet upward (A-03), so the test pins the first counts as a floor: a downward edit
// of the committed file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/admission.json', import.meta.url));
const integrationFile = (name: string): string =>
  fileURLToPath(new URL(`../../integration/admission/${name}`, import.meta.url));
const AC_CASE_FILES = [
  {
    file: integrationFile('pre-execution-rejection.integration.test.ts'),
    describes: ['financial-input'],
    cases: [
      'financial-input-unequal-amounts',
      'financial-input-zero-amount',
      'financial-input-unsafe-amount',
      'financial-input-non-brl-currency',
      'identity',
      'source-provenance',
      'account',
      'region',
      'safety',
      'qualification',
      'coordination-configuration',
    ],
  },
  {
    file: integrationFile('qualification-drift-admission.integration.test.ts'),
    describes: [],
    cases: ['scoped-source-change', 'scoped-dependency-change', 'unrelated-oracle-change'],
  },
  {
    file: integrationFile('oracle-attestation.integration.test.ts'),
    describes: [],
    cases: ['failing-report', 'under-covered-report'],
  },
] as const;
/** The WP-23 first delivery. */
const RATIFIED_FLOOR = { unit: 129, integration: 104, fuzz: 9 } as const;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('admission suite minimums', () => {
  it('hold at least the §14 AC-RUA-014, AC-RUA-051 and AC-RUA-055 integration cases', () => {
    assert.ok((minimums().integration ?? 0) >= 8 + 1 + 2);
  });

  it('never fall below the ratified counts (they only ratchet upward)', () => {
    const counts = minimums();
    for (const suite of ['unit', 'integration', 'fuzz'] as const) {
      assert.ok(
        (counts[suite] ?? 0) >= RATIFIED_FLOOR[suite],
        `${suite} minimum ${String(counts[suite])}; expected >= ${String(RATIFIED_FLOOR[suite])}`,
      );
    }
  });

  it('keep the AC-RUA-014, AC-RUA-051 and AC-RUA-055 cases §14 traces in their case files', () => {
    for (const { file, describes, cases } of AC_CASE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const name of describes) {
        assert.ok(source.includes(`describe('${name}',`), `group ${name} missing from ${file}`);
      }
      for (const name of cases) {
        assert.ok(source.includes(`it('${name}',`), `case ${name} missing from ${file}`);
      }
    }
  });
});
