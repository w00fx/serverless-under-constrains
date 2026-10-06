// AC-RUA-037 golden (BR-RUA-038, BR-RUA-044): frozen validation evidence that is missing or
// scientifically invalid stays effective `indeterminate` even when a valid amendment chain repairs
// the operational closure. Each package froze a partial cleanup, and a selected OPERATIONAL_RECOVERY
// amendment repairs it: the effective cleanup is `succeeded`, recovery applied, and the scientific
// reason remains.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { VariantValidationVerification } from '../../../src/record-contract/records/group-c/variant_validation_verification.ts';
import { CLEAN_CLOSURE, recoveryAmendment, validationPackage } from './support/validation-package.ts';
import type { ValidationScenario } from './support/validation-package.ts';
import { reasonCodesOf, verifyGolden } from './support/golden-verification.ts';

const PARTIAL_CLEANUP = { ...CLEAN_CLOSURE, cleanup_status: 'partial' } as const;

async function recoveredVerification(scenario: Partial<ValidationScenario>): Promise<VariantValidationVerification> {
  const fixture = validationPackage({ ...scenario, closure: PARTIAL_CLEANUP });
  assert.equal(fixture.summary.implementation_validation_status, 'indeterminate');
  const recovery = recoveryAmendment(fixture, CLEAN_CLOSURE);
  const { verification } = await verifyGolden(fixture, [recovery], recovery.index_sha256);
  assert.equal(verification.package_eligibility, 'eligible');
  assert.equal(verification.effective_cleanup_status, 'succeeded');
  assert.equal(verification.effective_leak_audit_status, 'clean');
  assert.equal(verification.effective_lease_status, 'released');
  assert.equal(verification.operational_recovery_applied, true);
  assert.equal(verification.effective_implementation_validation_status, 'indeterminate');
  return verification;
}

describe('AC-RUA-037 scientific evidence cannot be repaired operationally', () => {
  it('missing-scientific-evidence', async () => {
    const verification = await recoveredVerification({ treatment: 'not_frozen' });
    assert.equal(verification.validation_validity, 'indeterminate');
    assert.deepEqual(reasonCodesOf(verification), ['SCIENTIFIC_EVIDENCE_MISSING', 'TERMINAL_REASON_NOT_COMPLETED']);
  });

  it('invalid-admission-or-fidelity', async () => {
    const fidelity = await recoveredVerification({ treatment: 'fidelity_invalid' });
    assert.equal(fidelity.validation_validity, 'invalid');
    assert.deepEqual(reasonCodesOf(fidelity), [
      'TREATMENT_FIDELITY_NOT_VERIFIED',
      'TREATMENT_VERDICT_INDETERMINATE',
      'TRIAL_NOT_VALID',
    ]);

    const admission = await recoveredVerification({ revision_check: 'failed' });
    assert.equal(admission.validation_validity, 'invalid');
    assert.deepEqual(reasonCodesOf(admission), ['ADMISSION_INVALID']);
  });

  it('manifest-drift', async () => {
    const verification = await recoveredVerification({ treatment_manifest_drift: true });
    assert.equal(verification.validation_validity, 'invalid');
    assert.deepEqual(reasonCodesOf(verification), ['MANIFEST_DRIFT']);
  });
});
