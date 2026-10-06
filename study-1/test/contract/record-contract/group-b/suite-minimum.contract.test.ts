// The record-contract group-B suite minimum (design §12.1, D-33, Owner amendment A-03): the
// file exists and holds a contract minimum of at least the cases §14 lists for AC-RUA-046
// (casing, millisecond UTC, lowercase UUIDv4, safe-integer amounts, decimal aggregates, omitted
// versus null, schema_version and record_type present). The committed value sits at the number
// of group-B contract tests that exist and only ratchets upward; that is a review rule, not a test.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../../quality/suite-minimums/record-contract-group-b.json', import.meta.url),
);

// design §14 row 046: the seven contract cases of AC-RUA-046.
const AC_RUA_046_CONTRACT_CASES = 7;

describe('record-contract group-B suite minimum', () => {
  it('holds a contract minimum of at least the AC-RUA-046 cases', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    const contract = minimums.contract ?? 0;
    assert.ok(
      contract >= AC_RUA_046_CONTRACT_CASES,
      `contract minimum ${String(minimums.contract)}; expected >= ${String(AC_RUA_046_CONTRACT_CASES)}`,
    );
  });
});
