// AC-RUA-005 golden (BR-RUA-001, -009): a complete settled ledger with zero successful transactions
// fails BR-RUA-001 and -009, and the verdict is fail.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coreMismatches } from './support/oracle-golden.ts';

describe('AC-RUA-005 missing effect detection', () => {
  it('ac005-zero-tx', async () => {
    assert.deepEqual(await coreMismatches('ac005-zero-tx'), []);
  });
});
