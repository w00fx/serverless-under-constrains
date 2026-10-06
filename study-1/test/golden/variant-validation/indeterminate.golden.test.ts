// AC-RUA-036 golden (BR-RUA-038): when a scientific or an operational acceptance condition is
// indeterminate, implementation validation is `indeterminate`, with the condition as its reason.
// - scientific: a valid treatment trial whose preservation verdict is indeterminate (BR-RUA-004
//   cannot be judged), with every gate verified and a clean closure;
// - operational: two conclusive trials whose leak audit stayed `inconclusive`, with no recovery.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLEAN_CLOSURE, validationPackage } from './support/validation-package.ts';
import { reasonCodesOf, verifyGolden } from './support/golden-verification.ts';

describe('AC-RUA-036 indeterminate acceptance', () => {
  it('scientific-indeterminate', async () => {
    const fixture = validationPackage({ treatment: 'verdict_indeterminate' });
    assert.equal(fixture.summary.implementation_validation_status, 'indeterminate');
    assert.equal(fixture.summary.validation_validity, 'valid');
    assert.deepEqual(
      fixture.summary.status_reasons.map((reason) => reason.code),
      ['TREATMENT_VERDICT_INDETERMINATE'],
    );

    const { verification } = await verifyGolden(fixture, [], null);
    assert.equal(verification.package_eligibility, 'eligible');
    assert.equal(verification.effective_implementation_validation_status, 'indeterminate');
    assert.equal(verification.effective_cleanup_status, 'succeeded');
    assert.deepEqual(reasonCodesOf(verification), ['TREATMENT_VERDICT_INDETERMINATE']);
  });

  it('operational-indeterminate', async () => {
    const fixture = validationPackage({ closure: { ...CLEAN_CLOSURE, leak_audit_status: 'inconclusive' } });
    assert.equal(fixture.summary.implementation_validation_status, 'indeterminate');
    assert.equal(fixture.summary.validation_validity, 'valid');
    assert.equal(fixture.summary.validation_terminal_reason, 'LEAK_AUDIT_NOT_CLEAN');
    assert.deepEqual(fixture.summary.status_reasons.map((reason) => reason.code).toSorted(), [
      'LEAK_AUDIT_NOT_CLEAN',
      'TERMINAL_REASON_NOT_COMPLETED',
    ]);

    const { verification } = await verifyGolden(fixture, [], null);
    assert.equal(verification.package_eligibility, 'eligible');
    assert.equal(verification.effective_implementation_validation_status, 'indeterminate');
    assert.equal(verification.effective_leak_audit_status, 'inconclusive');
    assert.equal(verification.operational_recovery_applied, false);
    assert.deepEqual(reasonCodesOf(verification), ['LEAK_AUDIT_NOT_CLEAN']);
  });
});
