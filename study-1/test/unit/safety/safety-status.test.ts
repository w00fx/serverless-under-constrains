// BR-RUA-046 safety status precedence: breached > unverified > within_limits.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveSafetyStatus } from '../../../src/safety/safety-status.ts';

describe('deriveSafetyStatus', () => {
  it('is within_limits when every check is within its limit', () => {
    assert.equal(deriveSafetyStatus([{ result: 'within_limits' }, { result: 'within_limits' }]), 'within_limits');
  });

  it('is unverified when one check is unverified and none is breached', () => {
    assert.equal(deriveSafetyStatus([{ result: 'within_limits' }, { result: 'unverified' }]), 'unverified');
  });

  it('is breached when any check is breached, whatever else is unverified', () => {
    assert.equal(deriveSafetyStatus([{ result: 'unverified' }, { result: 'breached' }]), 'breached');
    assert.equal(deriveSafetyStatus([{ result: 'breached' }, { result: 'within_limits' }]), 'breached');
  });

  it('is unverified for no check at all, since nothing established the limits', () => {
    assert.equal(deriveSafetyStatus([]), 'unverified');
  });
});
