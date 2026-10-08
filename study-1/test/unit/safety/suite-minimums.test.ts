// The safety suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the file exists and
// holds at least the counts WP-23 delivered for the safety limits, the supervisor, the resource
// plan and the cost estimate (unit), and the USD arithmetic properties (fuzz).
//
// Values only ratchet upward (A-03), so the test pins the first counts as a floor: a downward edit
// of the committed file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/safety.json', import.meta.url));
/** The WP-23 first delivery. */
const RATIFIED_FLOOR = { unit: 40, fuzz: 3 } as const;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('safety suite minimums', () => {
  it('never fall below the ratified counts (they only ratchet upward)', () => {
    const counts = minimums();
    for (const suite of ['unit', 'fuzz'] as const) {
      assert.ok(
        (counts[suite] ?? 0) >= RATIFIED_FLOOR[suite],
        `${suite} minimum ${String(counts[suite])}; expected >= ${String(RATIFIED_FLOOR[suite])}`,
      );
    }
  });

  it('declare no integration suite, since safety has none', () => {
    assert.equal(minimums().integration, undefined);
  });

  it('count at least one unit case per safety module', () => {
    assert.ok((minimums().unit ?? 0) >= 5);
  });
});
