// The evidence-collection suite minimums (design §12.1, §14, D-33, Owner amendments A-03 and
// A-11): the file exists and holds at least the count of every suite this feature has. Values only
// ratchet upward (A-03), so the test pins the first counts as a floor: a downward edit of the
// committed file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../quality/suite-minimums/evidence-collection.json', import.meta.url),
);
/** The WP-25 counts after its single-pass review (first delivery: unit 122, integration 56, fuzz 9). */
const RATIFIED_FLOOR = { unit: 125, integration: 58, fuzz: 9 } as const;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('evidence-collection suite minimums', () => {
  it('hold a positive minimum for every suite the feature has', () => {
    const counts = minimums();
    for (const suite of Object.keys(RATIFIED_FLOOR) as (keyof typeof RATIFIED_FLOOR)[]) {
      assert.ok((counts[suite] ?? 0) >= 1, `${suite} minimum ${String(counts[suite])}; expected >= 1`);
    }
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
