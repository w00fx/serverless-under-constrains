// AC-RUA-004 golden (BR-RUA-001, -002, -006, -009): two successful full-refund transactions in a
// complete ledger fail BR-RUA-001, -002 and -009 on a trial that stays valid, both in a verified
// treatment trial and in a CONTROL trial whose second provider call leaves control integrity
// verified.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coreMismatches } from './support/oracle-golden.ts';

describe('AC-RUA-004 duplicate detection', () => {
  it('ac004-verified-treatment-two-tx', async () => {
    assert.deepEqual(await coreMismatches('ac004-verified-treatment-two-tx'), []);
  });
  it('ac004-valid-control-two-tx', async () => {
    assert.deepEqual(await coreMismatches('ac004-valid-control-two-tx'), []);
  });
});
