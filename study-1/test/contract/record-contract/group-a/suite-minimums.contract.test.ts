// The group A suite minimum (design §12.1, D-33, Owner amendment A-03): the file exists and its
// contract floor is at least the seven AC-RUA-046 cases §14 lists (casing, millisecond UTC,
// lowercase UUIDv4, safe-integer amounts, decimal aggregates, omitted versus null, and
// schema_version and record_type present). The committed value sits at the number of group A
// contract tests that exist today and only ratchets upward; that is a review rule, not a test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../../quality/suite-minimums/record-contract-group-a.json', import.meta.url),
);
const AC_RUA_046_CASES = 7;

describe('record-contract group A suite minimums', () => {
  it('hold a contract minimum of at least the AC-RUA-046 case count and no other suite', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.deepEqual(Object.keys(minimums), ['contract']);
    assert.ok(
      (minimums.contract ?? 0) >= AC_RUA_046_CASES,
      `contract minimum ${String(minimums.contract)}; expected >= ${String(AC_RUA_046_CASES)}`,
    );
  });
});
