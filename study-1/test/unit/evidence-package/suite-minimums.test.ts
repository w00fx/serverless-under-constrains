// The evidence-package suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the file
// exists and holds at least the §14 case count of every suite this feature has. §14 traces two
// case files here: AC-RUA-010 (golden, three cases) and AC-RUA-022 (unit, six cases); the fuzz
// floor holds the design §12.5 row 13 properties (AC-RUA-046 feed).
//
// Values only ratchet upward (A-03), so the test pins the first counts as a floor: a downward edit
// of the committed file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/evidence-package.json', import.meta.url));
const AC_CASE_FILES = [
  {
    file: fileURLToPath(new URL('../../golden/evidence-package/evidence-index.golden.test.ts', import.meta.url)),
    cases: ['ac010-primary-classes-exact-bytes', 'ac010-derived-flagged', 'ac010-excludes-self-and-late-evidence'],
  },
  {
    file: fileURLToPath(new URL('./verify-package.test.ts', import.meta.url)),
    cases: ['altered-byte', 'broken-parent', 'sequence-gap', 'cycle', 'unknown-descendant', 'complete-chain-eligible'],
  },
] as const;
/** The WP-13 counts at first delivery, raised by its single-pass review (unit 135 to 142). */
const RATIFIED_FLOOR = { unit: 142, golden: 3, integration: 23, fuzz: 11 } as const;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('evidence-package suite minimums', () => {
  it('hold at least the §14 AC-RUA-010 golden and AC-RUA-022 unit cases', () => {
    const counts = minimums();
    assert.ok((counts.golden ?? 0) >= 3, `golden minimum ${String(counts.golden)}; expected >= 3`);
    assert.ok((counts.unit ?? 0) >= 6, `unit minimum ${String(counts.unit)}; expected >= 6`);
    assert.ok((counts.fuzz ?? 0) >= 1, `fuzz minimum ${String(counts.fuzz)}; expected >= 1`);
  });

  it('never fall below the ratified counts (they only ratchet upward)', () => {
    const counts = minimums();
    for (const suite of ['unit', 'golden', 'integration', 'fuzz'] as const) {
      assert.ok(
        (counts[suite] ?? 0) >= RATIFIED_FLOOR[suite],
        `${suite} minimum ${String(counts[suite])}; expected >= ${String(RATIFIED_FLOOR[suite])}`,
      );
    }
  });

  it('keep the AC-RUA-010 and AC-RUA-022 cases §14 traces in their case files', () => {
    for (const { file, cases } of AC_CASE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const name of cases) {
        assert.ok(source.includes(`it('${name}',`), `case ${name} missing from ${file}`);
      }
    }
  });
});
