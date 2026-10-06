// BR-RUA-029 trial validity (design §8.4): invalid beats unverified, unverified beats verified, and
// not-applicable gates are ignored.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateValue } from '../../../src/record-contract/primitives.ts';
import { deriveTrialValidity } from '../../../src/trial-oracle/trial-validity.ts';

const gates = (...values: readonly GateValue[]): readonly { readonly value: GateValue }[] =>
  values.map((value) => ({ value }));

describe('deriveTrialValidity', () => {
  it('is valid when every applicable gate is verified', () => {
    assert.equal(deriveTrialValidity(gates('verified', 'not_applicable', 'verified')), 'valid');
  });

  it('is valid when no gate applies', () => {
    assert.equal(deriveTrialValidity(gates('not_applicable')), 'valid');
  });

  it('is indeterminate when an applicable gate is unverified and none is invalid', () => {
    assert.equal(deriveTrialValidity(gates('verified', 'unverified', 'not_applicable')), 'indeterminate');
  });

  it('is invalid when any applicable gate is invalid, even beside an unverified one', () => {
    assert.equal(deriveTrialValidity(gates('unverified', 'invalid', 'verified')), 'invalid');
  });
});
