// The transport-probe-caller suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the
// file exists and holds at least the §14 case count of every suite this feature has. §14 names
// one offline case file for this feature, the AC-RUA-002 supplementary rehearsal
// (`integration/transport-probe-caller/probe-rehearsal.integration.test.ts`), whose six cases
// set the integration floor; unit and fuzz each hold at least one. The committed values sit at
// the counts that exist today and only ratchet upward, which is a review rule.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../quality/suite-minimums/transport-probe-caller.json', import.meta.url),
);
const AC_RUA_002_REHEARSAL_CASES = 6;

describe('transport-probe-caller suite minimums', () => {
  it('hold at least the §14 rehearsal cases and a positive unit and fuzz minimum', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.ok(
      (minimums.integration ?? 0) >= AC_RUA_002_REHEARSAL_CASES,
      `integration minimum ${String(minimums.integration)}; expected >= ${String(AC_RUA_002_REHEARSAL_CASES)}`,
    );
    assert.ok((minimums.unit ?? 0) >= 1, `unit minimum ${String(minimums.unit)}; expected >= 1`);
    assert.ok((minimums.fuzz ?? 0) >= 1, `fuzz minimum ${String(minimums.fuzz)}; expected >= 1`);
  });
});
