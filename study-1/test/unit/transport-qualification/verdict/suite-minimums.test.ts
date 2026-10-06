// The transport-qualification verdict suite minimums (design §12.1, §14, D-33, Owner amendments
// A-03 and A-11): the file exists and holds at least the §14 case count of every suite this
// feature has. §14 traces four golden files here: AC-RUA-002 and AC-RUA-021 (three cases in
// probe-pass), AC-RUA-031 (six in probe-fail), AC-RUA-032 (four in probe-indeterminate) and
// AC-RUA-056 (five in probe-usability), which set the golden floor of 18; the fuzz floor holds the
// verdict precedence, result and usability properties.
//
// Values only ratchet upward (A-03), so the test pins the first counts as a floor: a downward edit
// of the committed file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../../quality/suite-minimums/transport-qualification-verdict.json', import.meta.url),
);
const GOLDEN_DIRECTORY = new URL('../../../golden/transport-qualification/verdict/', import.meta.url);

/** The §14 cases of each golden file, by file name. */
const SECTION_14_CASES: Readonly<Record<string, readonly string[]>> = {
  'probe-pass.golden.test.ts': [
    'ac002-condition-derivation',
    'ac021-probe-verdict-pass',
    'ac021-usable-probe-selectable',
  ],
  'probe-fail.golden.test.ts': [
    'br010-reversed-timestamps',
    'br011-transport-settled-first',
    'br012-provider-stopped',
    'br013-wrong-signal-causation',
    'br014-release-before-observation',
    'br015-caller-observed-success',
  ],
  'probe-indeterminate.golden.test.ts': [
    'equal-timestamps',
    'missing-timestamp',
    'safety-release',
    'extra-accepted-call',
  ],
  'probe-usability.golden.test.ts': [
    'unclean-operational-closure',
    'package-not-verified',
    'contradictory-late-evidence',
    'no-transport-scope-snapshot',
    'known-safety-breach',
  ],
};
/** The WP-10 counts at first delivery. */
const RATIFIED_FLOOR = { unit: 75, golden: 18, fuzz: 3 } as const;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('transport-qualification verdict suite minimums', () => {
  it('hold at least the 18 §14 golden cases and a fuzz property', () => {
    const counts = minimums();
    const cases = Object.values(SECTION_14_CASES).flat().length;
    assert.equal(cases, 18);
    assert.ok((counts.golden ?? 0) >= cases, `golden minimum ${String(counts.golden)}; expected >= ${String(cases)}`);
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

  it('keep every §14 case in the golden file that traces it', () => {
    for (const [file, cases] of Object.entries(SECTION_14_CASES)) {
      const path = fileURLToPath(new URL(file, GOLDEN_DIRECTORY));
      const source = readFileSync(path, 'utf8');
      for (const name of cases) {
        assert.ok(source.includes(`it('${name}',`), `case ${name} missing from ${path}`);
      }
    }
  });
});
