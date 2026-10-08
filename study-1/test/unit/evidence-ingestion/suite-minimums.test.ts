// The evidence-ingestion suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the file
// exists and holds at least the §14 case count of every suite this feature has. §14 traces one
// case file here: AC-RUA-047 (golden, nine cases); the fuzz floor holds the design §12.5
// properties of ingestion totality and the BR-RUA-034 duplicate and gap rules (AC-RUA-046 feed).
//
// Values only ratchet upward (A-03), so the test pins the first counts as a floor: a downward edit
// of the committed file fails here. Raise both together.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../quality/suite-minimums/evidence-ingestion.json', import.meta.url),
);
const AC_047_FILE = fileURLToPath(
  new URL('../../golden/evidence-ingestion/duplicates-and-conflicts.golden.test.ts', import.meta.url),
);
const AC_047_CASES = [
  'equivalent-duplicate-collapsed',
  'conflicting-event-content',
  'conflicting-source-sequence',
  'sequence-gap',
  'missing-causal-predecessor',
  'duplicate-ledger-tx-id',
  'incomplete-pagination',
  'core-file-digest-mismatch',
  'ledger-larger-than-expected-not-truncated',
] as const;
/** The WP-12 counts after its single-pass review (first delivery: unit 146, golden 9, fuzz 4). */
const RATIFIED_FLOOR = { unit: 159, golden: 9, fuzz: 5 } as const;

function minimums(): ReturnType<typeof parseSuiteMinimums> {
  return parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
}

describe('evidence-ingestion suite minimums', () => {
  it('hold at least the §14 AC-RUA-047 golden cases and a fuzz property', () => {
    const counts = minimums();
    assert.ok((counts.golden ?? 0) >= AC_047_CASES.length, `golden minimum ${String(counts.golden)}; expected >= 9`);
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

  it('keep the nine AC-RUA-047 cases §14 traces in their case file', () => {
    const source = readFileSync(AC_047_FILE, 'utf8');
    for (const name of AC_047_CASES) {
      assert.ok(source.includes(`it('${name}',`), `case ${name} missing from ${AC_047_FILE}`);
    }
  });
});
