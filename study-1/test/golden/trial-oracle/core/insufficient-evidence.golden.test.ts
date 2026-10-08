// AC-RUA-007 golden (BR-RUA-006, -029, -032): one case per missing input (incomplete ledger
// pagination, settlement not established by the deadline, the caller journal absent). The affected
// rules are indeterminate, the verdict is indeterminate with correct_completion null, and the
// structured reasons name the missing evidence.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coreMismatches } from './support/oracle-golden.ts';

describe('AC-RUA-007 insufficient evidence', () => {
  it('ac007-ledger-pagination-incomplete', async () => {
    assert.deepEqual(await coreMismatches('ac007-ledger-pagination-incomplete'), []);
  });
  it('ac007-settlement-not-established', async () => {
    assert.deepEqual(await coreMismatches('ac007-settlement-not-established'), []);
  });
  it('ac007-caller-journal-absent', async () => {
    assert.deepEqual(await coreMismatches('ac007-caller-journal-absent'), []);
  });
});
