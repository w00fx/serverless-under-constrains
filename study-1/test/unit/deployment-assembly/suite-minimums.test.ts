// The deployment-assembly suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the file
// exists and holds at least the §14 case count of every suite this feature has. §14 traces
// AC-RUA-053 (integration) to `platform-constraints` with one case per §9.13 constraint (1-4) and
// the supplementary cases 4a-4h, plus the IAM matrix and the frozen assembly; the fuzz floor holds
// the WP-24 totality properties.
//
// Values only ratchet upward (A-03), so the test pins the first counts as a floor: a downward edit
// of the committed file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../quality/suite-minimums/deployment-assembly.json', import.meta.url),
);
const AC_CASE_FILES = [
  {
    file: fileURLToPath(
      new URL('../../integration/deployment-assembly/platform-constraints.integration.test.ts', import.meta.url),
    ),
    cases: [
      "describe('case 1:",
      "describe('case 2:",
      "describe('case 3:",
      "describe('case 4:",
      "it('4a:",
      "it('4b:",
      "it('4c:",
      "it('4d:",
      "it('4e:",
      "it('4f:",
      "it('4g (RK-12):",
      "it('4h:",
      "describe('addendum §2: no provisioned concurrency'",
    ],
  },
  {
    file: fileURLToPath(
      new URL('../../integration/deployment-assembly/iam-isolation.integration.test.ts', import.meta.url),
    ),
    cases: ["it('no caller role reaches the ledger, the control table or the experiment journal (BR-RUA-018)'"],
  },
  {
    file: fileURLToPath(
      new URL('../../integration/deployment-assembly/frozen-assembly.integration.test.ts', import.meta.url),
    ),
    cases: ["it('deploys from the copy, whose lock file never reaches the package, and the package re-verifies'"],
  },
] as const;
/** The WP-24 counts at first delivery. */
const RATIFIED_FLOOR = { unit: 107, integration: 69, fuzz: 9 } as const;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('deployment-assembly suite minimums', () => {
  it('hold at least the §14 AC-RUA-053 integration cases', () => {
    const counts = minimums();
    assert.ok((counts.integration ?? 0) >= 13, `integration minimum ${String(counts.integration)}; expected >= 13`);
    assert.ok((counts.fuzz ?? 0) >= 1, `fuzz minimum ${String(counts.fuzz)}; expected >= 1`);
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

  it('keep the AC-RUA-053 cases §14 traces in their case files', () => {
    for (const { file, cases } of AC_CASE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const name of cases) {
        assert.ok(source.includes(name), `case ${name} missing from ${file}`);
      }
    }
  });
});
