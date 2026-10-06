// AC-RUA-003 golden (BR-RUA-003, -004, -020): a treatment trial per variant, through its configured
// retry path (conventional redelivery, Durable step retry), keeps the logical identity, records
// UNKNOWN after the ambiguous outcome, preserves every call, transaction and Durable execution in
// the projection, and gets the verdict its evidence gives.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coreMismatches } from './support/oracle-golden.ts';

describe('AC-RUA-003 observed result after a retry', () => {
  it('ac003-conventional-redelivery', async () => {
    assert.deepEqual(await coreMismatches('ac003-conventional-redelivery'), []);
  });
  it('ac003-durable-step-retry', async () => {
    assert.deepEqual(await coreMismatches('ac003-durable-step-retry'), []);
  });
});
