// The trial-execution suite minimums (design §12.1, §14, D-33, Owner amendments A-03 and A-11):
// the file exists and holds at least the count of every suite this feature has, and at least the
// six AC-RUA-019 and AC-RUA-020 integration cases design §14 lists. Values only ratchet upward
// (A-03), so the test pins the counts after CMP-04 (the probe workload) as a floor: a downward edit of the
// committed file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/trial-execution.json', import.meta.url));
/** The CMP-04 counts after its single-pass review (WP-26 ratified 24, 72 and 2 after its own). */
const RATIFIED_FLOOR = { unit: 67, integration: 122, fuzz: 7 } as const;
/** Design §14: AC-RUA-019 has two integration cases and AC-RUA-020 four. */
const AC_INTEGRATION_CASES = 6;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('trial-execution suite minimums', () => {
  it('hold a positive minimum for every suite the feature has, and the §14 integration cases', () => {
    const counts = minimums();
    for (const suite of Object.keys(RATIFIED_FLOOR) as (keyof typeof RATIFIED_FLOOR)[]) {
      assert.ok((counts[suite] ?? 0) >= 1, `${suite} minimum ${String(counts[suite])}; expected >= 1`);
    }
    assert.ok(
      (counts.integration ?? 0) >= AC_INTEGRATION_CASES,
      `integration minimum ${String(counts.integration)}; expected >= ${String(AC_INTEGRATION_CASES)}`,
    );
  });

  it('never fall below the ratified counts (they only ratchet upward)', () => {
    const counts = minimums();
    for (const suite of Object.keys(RATIFIED_FLOOR) as (keyof typeof RATIFIED_FLOOR)[]) {
      assert.ok(
        (counts[suite] ?? 0) >= RATIFIED_FLOOR[suite],
        `${suite} minimum ${String(counts[suite])}; expected >= ${String(RATIFIED_FLOOR[suite])}`,
      );
    }
  });
});
