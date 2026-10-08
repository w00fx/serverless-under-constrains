// The group-C suite minimums (design §12.1, §14, D-33, Owner amendments A-03 and A-11): WP-03
// owns contract tests and, since A-11, the §12.5 single-field mutation property under
// test/fuzz/record-contract/group-c/. §14 lists seven AC-RUA-046 contract cases for the catalogue
// (casing, millisecond UTC, lowercase UUIDv4, safe-integer amounts, decimal aggregates, omitted
// versus null, schema_version and record_type present), so the contract minimum is at least
// seven, and the fuzz minimum holds at least the two property tests (leaf and member mutations).
// The committed value sits at the count that exists today and only ratchets upward, which is a
// review rule.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSuiteMinimums } from '../../../../tools/lib/suite-accounting.ts';

const MINIMUMS_PATH = fileURLToPath(
  new URL('../../../../quality/suite-minimums/record-contract-group-c.json', import.meta.url),
);
/** The AC-RUA-046 contract cases design §14 lists. */
const SECTION_14_CONTRACT_CASES = 7;
/** The §12.5 property tests: a leaf replaced by another kind, and an unknown member added. */
const SECTION_12_5_PROPERTY_TESTS = 2;

describe('record-contract group-C suite minimums', () => {
  it('hold a contract minimum of at least the §14 AC-RUA-046 cases, a fuzz minimum, and no other suite', () => {
    const minimums = parseSuiteMinimums(MINIMUMS_PATH, JSON.parse(readFileSync(MINIMUMS_PATH, 'utf8')));
    assert.deepEqual(Object.keys(minimums), ['contract', 'fuzz']);
    assert.ok(
      (minimums.fuzz ?? 0) >= SECTION_12_5_PROPERTY_TESTS,
      `fuzz minimum ${String(minimums.fuzz)}; expected >= ${String(SECTION_12_5_PROPERTY_TESTS)}`,
    );
    assert.ok(
      (minimums.contract ?? 0) >= SECTION_14_CONTRACT_CASES,
      `contract minimum ${String(minimums.contract)}; expected >= ${String(SECTION_14_CONTRACT_CASES)}`,
    );
  });
});
