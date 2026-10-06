// AC-RUA-035 golden (BR-RUA-038): one variant's validation trials with trustworthy conclusive
// evidence whose control preservation is `fail` make implementation validation `failed`, in the
// frozen summary and in the CTR-RUA-004 verification alike.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validationPackage } from './support/validation-package.ts';
import { reasonCodesOf, verifyGolden } from './support/golden-verification.ts';

describe('AC-RUA-035 a trustworthy control fail', () => {
  it('trustworthy-control-fail', async () => {
    const fixture = validationPackage({ control: 'fail', treatment: 'pass' });
    assert.equal(fixture.summary.implementation_validation_status, 'failed');
    assert.equal(fixture.summary.validation_validity, 'valid');
    assert.equal(fixture.summary.validation_terminal_reason, 'COMPLETED');
    assert.deepEqual(
      fixture.summary.status_reasons.map((reason) => reason.code),
      ['CONTROL_PRESERVATION_FAILED'],
    );

    const { verification } = await verifyGolden(fixture, [], null);
    assert.equal(verification.package_eligibility, 'eligible');
    assert.equal(verification.declared_implementation_validation_status, 'failed');
    assert.equal(verification.effective_implementation_validation_status, 'failed');
    assert.equal(verification.validation_validity, 'valid');
    assert.deepEqual(reasonCodesOf(verification), ['CONTROL_PRESERVATION_FAILED']);
  });
});
