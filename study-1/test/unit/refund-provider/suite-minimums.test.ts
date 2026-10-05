// The refund-provider suite minimums (design §12.1, §14, D-33, Owner amendment A-03): the file
// exists and holds at least the §14 case count of every suite this feature has. §14 maps
// AC-RUA-042 to seven unit cases; integration (the provider over the store emulator) and fuzz
// (acceptance totality and the guard/schema differential) each hold at least one. The committed
// values sit at the counts that exist today and only ratchet upward; that is a review rule.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(new URL('../../../quality/suite-minimums/refund-provider.json', import.meta.url));
const AC_RUA_042_UNIT_CASES = 7;

describe('refund-provider suite minimums', () => {
  it('hold at least the §14 unit cases and a positive integration and fuzz minimum', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.ok(
      (minimums.unit ?? 0) >= AC_RUA_042_UNIT_CASES,
      `unit minimum ${String(minimums.unit)}; expected >= ${String(AC_RUA_042_UNIT_CASES)}`,
    );
    assert.ok((minimums.integration ?? 0) >= 1, `integration minimum ${String(minimums.integration)}; expected >= 1`);
    assert.ok((minimums.fuzz ?? 0) >= 1, `fuzz minimum ${String(minimums.fuzz)}; expected >= 1`);
  });
});
