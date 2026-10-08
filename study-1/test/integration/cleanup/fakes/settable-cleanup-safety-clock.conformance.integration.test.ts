// Conformance of SettableCleanupSafetyClock to the CleanupSafetyClock contract: the total-time
// verdict starts not exceeded and, once exceeded, stays exceeded (time only moves forward).
//
// Sources (RK-17): no AWS service is emulated; the contract is the project's CleanupSafetyClock
// (BR-RUA-046 safety limits, AC-RUA-049 duration breach; design §10.4 step 11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SettableCleanupSafetyClock } from '../../../support/cleanup/settable-cleanup-safety-clock.ts';

describe('SettableCleanupSafetyClock conformance', () => {
  it('starts within the target and stays exceeded once exceeded', () => {
    const safety = new SettableCleanupSafetyClock();
    assert.equal(safety.totalTargetExceeded(), false);
    safety.exceed();
    assert.equal(safety.totalTargetExceeded(), true);
    safety.exceed();
    assert.equal(safety.totalTargetExceeded(), true);
  });
});
