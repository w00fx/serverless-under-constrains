// The group A suite minimum (design §12.1, D-33, Owner amendment A-03): the file exists and its
// contract floor is at least the seven AC-RUA-046 cases §14 lists (casing, millisecond UTC,
// lowercase UUIDv4, safe-integer amounts, decimal aggregates, omitted versus null, and
// schema_version and record_type present), and a fuzz floor of at least the one §12.5 property
// test that Owner amendment A-11 placed under test/fuzz/record-contract/group-a/. The committed
// values sit at the number of group A tests that exist today and only ratchet upward; that is a
// review rule, not a test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../../quality/suite-minimums/record-contract-group-a.json', import.meta.url),
);
const AC_RUA_046_CASES = 7;
const SECTION_12_5_PROPERTY_TESTS = 1;

describe('record-contract group A suite minimums', () => {
  it('hold a contract minimum of at least the AC-RUA-046 case count, a fuzz minimum and no other suite', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.deepEqual(Object.keys(minimums), ['contract', 'fuzz']);
    assert.ok(
      (minimums.fuzz ?? 0) >= SECTION_12_5_PROPERTY_TESTS,
      `fuzz minimum ${String(minimums.fuzz)}; expected >= ${String(SECTION_12_5_PROPERTY_TESTS)}`,
    );
    assert.ok(
      (minimums.contract ?? 0) >= AC_RUA_046_CASES,
      `contract minimum ${String(minimums.contract)}; expected >= ${String(AC_RUA_046_CASES)}`,
    );
  });
});
