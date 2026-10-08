// AC-RUA-013 golden (BR-RUA-001, -009): one successful transaction with a wrong amount, currency,
// request identity or payment identity fails BR-RUA-009, and the verdict is fail; BR-RUA-001 passes
// its count except for the wrong request identity, whose count for the approved request is 0.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coreMismatches } from './support/oracle-golden.ts';

describe('AC-RUA-013 exact-effect mismatch', () => {
  it('wrong-amount', async () => {
    assert.deepEqual(await coreMismatches('wrong-amount'), []);
  });
  it('wrong-currency', async () => {
    assert.deepEqual(await coreMismatches('wrong-currency'), []);
  });
  it('wrong-request-identity', async () => {
    assert.deepEqual(await coreMismatches('wrong-request-identity'), []);
  });
  it('wrong-payment-identity', async () => {
    assert.deepEqual(await coreMismatches('wrong-payment-identity'), []);
  });
});
