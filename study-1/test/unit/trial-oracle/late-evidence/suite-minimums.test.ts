// The WP-15 suite minimums (design §12.1, §14, D-33, Owner amendments A-03 and A-11): the
// late-evidence feature's unit and fuzz minimums and the integrity goldens' golden minimum. Each
// file exists and holds at least the count of every suite its feature has. Values only ratchet
// upward (A-03), so each test pins the first counts as a floor: a downward edit of a committed
// file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../../tools/lib/suite-accounting.ts';

type SuiteFloor = Readonly<Partial<Record<'unit' | 'golden' | 'fuzz', number>>>;

function minimumsOf(feature: string): ReturnType<typeof parseSuiteMinimums> {
  const path = fileURLToPath(new URL(`../../../../quality/suite-minimums/${feature}.json`, import.meta.url));
  return parseSuiteMinimums(path, JSON.parse(readFileSync(path, 'utf8')));
}

function describeFloor(feature: string, floor: SuiteFloor): void {
  const suites = Object.keys(floor) as (keyof SuiteFloor)[];
  describe(`${feature} suite minimums`, () => {
    it('hold a positive minimum for every suite the feature has', () => {
      const counts = minimumsOf(feature);
      for (const suite of suites) {
        assert.ok((counts[suite] ?? 0) >= 1, `${suite} minimum ${String(counts[suite])}; expected >= 1`);
      }
    });

    it('never fall below the ratified counts (they only ratchet upward)', () => {
      const counts = minimumsOf(feature);
      for (const suite of suites) {
        const ratified = floor[suite] ?? 0;
        assert.ok(
          (counts[suite] ?? 0) >= ratified,
          `${suite} minimum ${String(counts[suite])}; expected >= ${String(ratified)}`,
        );
      }
    });
  });
}

/** The WP-15 counts at first delivery. */
describeFloor('trial-oracle-late-evidence', { unit: 90, fuzz: 7 });
describeFloor('trial-oracle-integrity', { golden: 36 });
