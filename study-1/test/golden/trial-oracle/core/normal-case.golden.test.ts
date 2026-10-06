// AC-RUA-001 golden (BR-RUA-001, -002, -006, -009, -016, -030): a settled CONTROL trial per variant
// with exactly the authorized transaction passes, with correct_completion true. Each case states its
// expectation from the AC text; the comparison is a partial match over the oracle's outputs, after
// both outputs are checked against their schemas and BR-RUA-035.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coreMismatches } from './support/oracle-golden.ts';

describe('AC-RUA-001 normal case', () => {
  it('ac001-conventional-control', async () => {
    assert.deepEqual(await coreMismatches('ac001-conventional-control'), []);
  });
  it('ac001-durable-control', async () => {
    assert.deepEqual(await coreMismatches('ac001-durable-control'), []);
  });
});
