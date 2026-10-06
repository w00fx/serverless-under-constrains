// How a safety assessment bears on a validation's status (BR-RUA-038, BR-RUA-046, OR-RUA-005): a
// breach or any safety uncertainty blocks verification, except a billed-cost check left unverified
// by delayed billing while the estimate and every real-time safeguard held.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REAL_TIME_SAFEGUARDS,
  assessSafetyStanding,
  safetyReasons,
} from '../../../src/variant-validation/safety-standing.ts';
import { SAFEGUARDS_WITHIN_LIMITS, safetyAssessment, safetyCheck } from './support/validation-inputs.ts';

function codes(standing: ReturnType<typeof assessSafetyStanding>): readonly string[] {
  return safetyReasons(standing).map((reason) => reason.code);
}

describe('assessSafetyStanding', () => {
  it('is unverified when no readable assessment exists', () => {
    const standing = assessSafetyStanding(undefined);
    assert.equal(standing.standing, 'unverified');
    assert.deepEqual(codes(standing), ['SAFETY_UNVERIFIED']);
  });

  it('is within limits when every check held', () => {
    assert.deepEqual(assessSafetyStanding(safetyAssessment('within_limits', SAFEGUARDS_WITHIN_LIMITS)), {
      standing: 'within_limits',
    });
  });

  it('is breached with one reason per breached check naming the observed value and the limit', () => {
    const checks = [
      ...SAFEGUARDS_WITHIN_LIMITS,
      safetyCheck('TOTAL_TIME', 'breached'),
      safetyCheck('ACTIVE_TIME', 'breached'),
    ];
    const standing = assessSafetyStanding(safetyAssessment('breached', checks));
    assert.equal(standing.standing, 'breached');
    assert.deepEqual(codes(standing), ['SAFETY_BREACHED', 'SAFETY_BREACHED']);
    assert.match(safetyReasons(standing)[0]?.detail ?? '', /TOTAL_TIME observed 1 unit against limit 2 units/);
  });

  it('is breached when the status says so even without a breached check', () => {
    const standing = assessSafetyStanding(safetyAssessment('breached', SAFEGUARDS_WITHIN_LIMITS));
    assert.equal(standing.standing, 'breached');
    assert.match(safetyReasons(standing)[0]?.detail ?? '', /safety_status is breached/);
  });

  it('names a breached check without an observed value', () => {
    const { observed: _observed, ...noValue } = safetyCheck('REGION', 'breached');
    const standing = assessSafetyStanding(safetyAssessment('breached', [noValue]));
    assert.match(safetyReasons(standing)[0]?.detail ?? '', /REGION observed no value/);
  });

  it('tolerates a pending bill when only BILLED_COST is unverified and every real-time safeguard held (OR-RUA-005)', () => {
    const checks = [...SAFEGUARDS_WITHIN_LIMITS, safetyCheck('BILLED_COST', 'unverified')];
    const standing = assessSafetyStanding(safetyAssessment('unverified', checks));
    assert.deepEqual(standing, { standing: 'billing_pending' });
    assert.deepEqual(safetyReasons(standing), []);
  });

  it('does not tolerate a pending bill when a real-time safeguard is missing or not within limits', () => {
    for (const missing of REAL_TIME_SAFEGUARDS) {
      const checks = [
        ...SAFEGUARDS_WITHIN_LIMITS.filter((check) => check.boundary !== missing),
        safetyCheck('BILLED_COST', 'unverified'),
      ];
      const standing = assessSafetyStanding(safetyAssessment('unverified', checks));
      assert.equal(standing.standing, 'unverified');
      assert.match(safetyReasons(standing)[0]?.detail ?? '', new RegExp(`${missing} is not recorded within limits`));
    }
  });

  it('treats any other unverified boundary as other safety uncertainty', () => {
    const checks = [
      ...SAFEGUARDS_WITHIN_LIMITS,
      safetyCheck('BILLED_COST', 'unverified'),
      safetyCheck('CLEANUP_TERMINAL', 'unverified'),
    ];
    const standing = assessSafetyStanding(safetyAssessment('unverified', checks));
    assert.equal(standing.standing, 'unverified');
    assert.deepEqual(
      safetyReasons(standing).map((reason) => reason.detail.split(';')[0]),
      ['CLEANUP_TERMINAL is unverified'],
    );
  });

  it('treats an unverified status without any unverified check as uncertainty', () => {
    const standing = assessSafetyStanding(safetyAssessment('unverified', SAFEGUARDS_WITHIN_LIMITS));
    assert.equal(standing.standing, 'unverified');
    assert.deepEqual(codes(standing), ['SAFETY_UNVERIFIED']);
    assert.match(safetyReasons(standing)[0]?.detail ?? '', /safety_status is unverified with no unverified check/);
  });

  it('treats a within-limits status with an unverified check as pending, not as clean', () => {
    const checks = [...SAFEGUARDS_WITHIN_LIMITS, safetyCheck('BILLED_COST', 'unverified')];
    assert.deepEqual(assessSafetyStanding(safetyAssessment('within_limits', checks)), { standing: 'billing_pending' });
  });
});

describe('safetyReasons', () => {
  it('adds no reason for within_limits or billing_pending, and the standing reasons otherwise', () => {
    assert.deepEqual(safetyReasons({ standing: 'within_limits' }), []);
    assert.deepEqual(safetyReasons({ standing: 'billing_pending' }), []);
    const reason = { code: 'SAFETY_BREACHED', subject: 'safety_status', detail: 'd' } as const;
    assert.deepEqual(safetyReasons({ standing: 'breached', reasons: [reason] }), [reason]);
  });
});
