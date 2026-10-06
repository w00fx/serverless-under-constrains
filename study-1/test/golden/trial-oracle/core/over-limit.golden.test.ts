// AC-RUA-040 golden (BR-RUA-002, -009): one successful transaction of 20000 against a captured 10000
// passes the BR-RUA-001 count and fails BR-RUA-002 and -009.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coreMismatches } from './support/oracle-golden.ts';

describe('AC-RUA-040 one transaction exceeds the payment limit', () => {
  it('single-20000-tx', async () => {
    assert.deepEqual(await coreMismatches('single-20000-tx'), []);
  });
});
