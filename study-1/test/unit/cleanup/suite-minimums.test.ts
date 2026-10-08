// The cleanup suite minimums (design §12.1, D-33, Owner amendment A-03): the file exists and
// holds a minimum for every suite this feature has. §14 maps AC-RUA-011 to the integration
// suite with eight cases (the seven named outcomes plus the RK-10 durable-execution case), so
// the integration floor is at least eight; unit (ownership, statuses, fold, history) and fuzz
// (the cleanup journal read back as untrusted input, testing rule 6) hold at least one case.
// The committed values sit at the counts that exist today and only ratchet upward; that is a
// review rule, not a test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/cleanup.json', import.meta.url));
const AC_RUA_011_CASES = 8;

describe('cleanup suite minimums', () => {
  it('hold the AC-RUA-011 integration floor and a positive unit and fuzz minimum', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.ok(
      (minimums.integration ?? 0) >= AC_RUA_011_CASES,
      `integration minimum ${String(minimums.integration)}; expected >= ${String(AC_RUA_011_CASES)}`,
    );
    assert.ok((minimums.unit ?? 0) >= 1, `unit minimum ${String(minimums.unit)}; expected >= 1`);
    assert.ok((minimums.fuzz ?? 0) >= 1, `fuzz minimum ${String(minimums.fuzz)}; expected >= 1`);
  });
});
