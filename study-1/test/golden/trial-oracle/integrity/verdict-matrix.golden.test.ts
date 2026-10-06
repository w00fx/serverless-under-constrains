// AC-RUA-055 verdict-matrix golden (BR-RUA-029, BR-RUA-030; design §8.8): one case per row of the
// BR-RUA-029 verdict matrix, row 4 twice (an invalid and an unverified treatment). Each case's
// expectation holds the row's preservation verdict and correct completion, written from the
// matrix; the row-11 case expects no oracle result at all.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { integrityMismatches } from './support/integrity-golden.ts';

describe('AC-RUA-055 BR-RUA-029 verdict matrix', () => {
  it('matrix-01', async () => {
    assert.deepEqual(await integrityMismatches('matrix-01'), []);
  });
  it('matrix-02', async () => {
    assert.deepEqual(await integrityMismatches('matrix-02'), []);
  });
  it('matrix-03', async () => {
    assert.deepEqual(await integrityMismatches('matrix-03'), []);
  });
  it('matrix-04a', async () => {
    assert.deepEqual(await integrityMismatches('matrix-04a'), []);
  });
  it('matrix-04b', async () => {
    assert.deepEqual(await integrityMismatches('matrix-04b'), []);
  });
  it('matrix-05', async () => {
    assert.deepEqual(await integrityMismatches('matrix-05'), []);
  });
  it('matrix-06', async () => {
    assert.deepEqual(await integrityMismatches('matrix-06'), []);
  });
  it('matrix-07', async () => {
    assert.deepEqual(await integrityMismatches('matrix-07'), []);
  });
  it('matrix-08', async () => {
    assert.deepEqual(await integrityMismatches('matrix-08'), []);
  });
  it('matrix-09', async () => {
    assert.deepEqual(await integrityMismatches('matrix-09'), []);
  });
  it('matrix-10', async () => {
    assert.deepEqual(await integrityMismatches('matrix-10'), []);
  });
  it('matrix-11', async () => {
    assert.deepEqual(await integrityMismatches('matrix-11'), []);
  });
});
