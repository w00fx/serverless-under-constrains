// fast-check parameters read from the environment (design §12.5).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

describe('fuzzParameters', () => {
  it('defaults to 1000 runs and no fixed seed', () => {
    assert.deepEqual(fuzzParameters({}), { numRuns: 1000 });
    assert.deepEqual(fuzzParameters({ FC_RUNS: '', FC_SEED: '' }), { numRuns: 1000 });
  });

  it('reads FC_RUNS and FC_SEED', () => {
    assert.deepEqual(fuzzParameters({ FC_RUNS: '10000', FC_SEED: '-17' }), { numRuns: 10000, seed: -17 });
    assert.deepEqual(fuzzParameters({ FC_SEED: '0' }), { numRuns: 1000, seed: 0 });
  });

  it('refuses a value that is not a safe integer', () => {
    assert.throws(() => fuzzParameters({ FC_RUNS: '1e99' }), { message: 'FC_RUNS="1e99"; expected a safe integer' });
    assert.throws(() => fuzzParameters({ FC_SEED: 'abc' }), { message: 'FC_SEED="abc"; expected a safe integer' });
  });

  it('reads the process environment by default', () => {
    assert.equal(typeof fuzzParameters().numRuns, 'number');
  });
});
