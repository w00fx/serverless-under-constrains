// AC-RUA-006 golden (BR-RUA-005): the caller's FINISHED/SUCCEEDED state cannot override a complete
// ledger without the authorized transaction; the monetary rules cite only the ledger snapshot and
// the business inputs.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coreMismatches } from './support/oracle-golden.ts';

describe('AC-RUA-006 authoritative source', () => {
  it('ac006-variant-success-ledger-without-tx', async () => {
    assert.deepEqual(await coreMismatches('ac006-variant-success-ledger-without-tx'), []);
  });
});
