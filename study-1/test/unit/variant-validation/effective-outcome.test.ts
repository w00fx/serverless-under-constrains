// The CTR-RUA-004 outcome fields: a conclusive effective status only with an eligible package, a
// valid validation and a clean effective closure; otherwise indeterminate with every unmet field.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EffectiveOperationalState } from '../../../src/evidence-package/effective-operational-state.ts';
import { effectiveOutcome } from '../../../src/variant-validation/effective-outcome.ts';
import { validationReason } from '../../../src/variant-validation/validation-reasons.ts';

const CLEAN_STATE: EffectiveOperationalState = {
  effective_cleanup_status: 'succeeded',
  effective_leak_audit_status: 'clean',
  effective_lease_status: 'released',
  operational_recovery_applied: false,
};

describe('effectiveOutcome', () => {
  it('builds the conclusive branch with its reasons when every field is met', () => {
    const failed = validationReason('CONTROL_PRESERVATION_FAILED', 'trial 1 (CONTROL)', 'fail; expected pass');
    const outcome = effectiveOutcome({
      status: 'failed',
      reasons: [failed],
      package_eligibility: 'eligible',
      validation_validity: 'valid',
      state: CLEAN_STATE,
    });
    assert.deepEqual(outcome, {
      outcome: {
        effective_implementation_validation_status: 'failed',
        package_eligibility: 'eligible',
        validation_validity: 'valid',
        effective_cleanup_status: 'succeeded',
        effective_leak_audit_status: 'clean',
        effective_lease_status: 'released',
      },
      reasons: [failed],
    });
  });

  it('downgrades a conclusive candidate to indeterminate with one reason per unmet field', () => {
    const outcome = effectiveOutcome({
      status: 'verified',
      reasons: [],
      package_eligibility: 'ineligible',
      validation_validity: 'indeterminate',
      state: {
        effective_cleanup_status: 'unverified',
        effective_leak_audit_status: 'unverified',
        effective_lease_status: 'unverified',
        operational_recovery_applied: false,
      },
    });
    assert.equal(outcome.outcome.effective_implementation_validation_status, 'indeterminate');
    assert.equal(outcome.outcome.effective_cleanup_status, 'unverified');
    assert.deepEqual(
      outcome.reasons.map((reason) => reason.code),
      ['PACKAGE_INELIGIBLE', 'TRIAL_NOT_VALID', 'CLEANUP_NOT_SUCCEEDED', 'LEAK_AUDIT_NOT_CLEAN', 'LEASE_NOT_RELEASED'],
    );
    assert.match(outcome.reasons[0]?.detail ?? '', /package_eligibility is ineligible; expected eligible/);
  });

  it('keeps an indeterminate candidate and its own reasons', () => {
    const reason = validationReason('SAFETY_BREACHED', 'safety_status', 'breached; expected within_limits');
    const outcome = effectiveOutcome({
      status: 'indeterminate',
      reasons: [reason],
      package_eligibility: 'eligible',
      validation_validity: 'valid',
      state: CLEAN_STATE,
    });
    assert.equal(outcome.outcome.effective_implementation_validation_status, 'indeterminate');
    assert.deepEqual(outcome.reasons, [reason]);
  });
});
