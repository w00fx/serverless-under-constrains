// The treatment-fidelity suite minimums (design §12.1, §14, D-33, Owner amendments A-03 and A-11):
// the file exists and holds at least the §14 case count of every suite this feature has. §14 traces
// no case file to this feature (its AC-RUA-002, 021, 031 and 032 cases live in the
// transport-qualification verdict goldens), so the unit and fuzz floors hold the six conditions,
// fidelity, control integrity and their totality properties.
//
// Values only ratchet upward (A-03), so the test pins the first counts as a floor: a downward edit
// of the committed file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../quality/suite-minimums/treatment-fidelity.json', import.meta.url),
);
/** The WP-10 counts at first delivery. */
const RATIFIED_FLOOR = { unit: 167, fuzz: 2 } as const;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('treatment-fidelity suite minimums', () => {
  it('hold a positive unit and fuzz minimum and no suite §14 does not trace here', () => {
    const counts = minimums();
    assert.ok((counts.unit ?? 0) >= 1, `unit minimum ${String(counts.unit)}; expected >= 1`);
    assert.ok((counts.fuzz ?? 0) >= 1, `fuzz minimum ${String(counts.fuzz)}; expected >= 1`);
    assert.equal(counts.golden, undefined);
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
});
