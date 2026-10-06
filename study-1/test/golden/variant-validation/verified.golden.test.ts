// AC-RUA-025 golden (BR-RUA-038): one variant's sequential control and treatment validation trials
// with trustworthy conclusive evidence and every operational acceptance gate satisfied. A control
// `pass` with a treatment `pass` or `fail` is implementation-validation `verified`, and the package
// makes no cross-variant claim. Expected values are the spec's: AC-RUA-025's Then clause, the
// CTR-RUA-004 field list, and the BR-RUA-038 summary shape (one variant, no `run_id`).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validationPackage } from './support/validation-package.ts';
import { verifyGolden } from './support/golden-verification.ts';
import { CONTROL_TRIAL_ID, TREATMENT_TRIAL_ID } from './support/validation-records.ts';

/** The validation summary's fields (design §6.3): one variant, two trials, no comparison member. */
const SUMMARY_FIELDS = [
  'cleanup_result_ref',
  'cleanup_status',
  'created_at',
  'evidence_integrity_status',
  'execution_manifest_sha256',
  'implementation_validation_status',
  'late_evidence_assessment_ref',
  'late_evidence_status',
  'leak_audit_status',
  'lease_status',
  'record_type',
  'safety_status',
  'schema_version',
  'status_reasons',
  'trial_results',
  'validation_terminal_reason',
  'validation_validity',
  'variant_id',
  'variant_validation_id',
];

/** CTR-RUA-004's fields plus `validation_validity`. */
const VERIFICATION_FIELDS = [
  'checked_at',
  'declared_implementation_validation_status',
  'effective_cleanup_status',
  'effective_implementation_validation_status',
  'effective_leak_audit_status',
  'effective_lease_status',
  'effective_status_reasons',
  'evidence_refs',
  'operational_recovery_applied',
  'original_package_index_sha256',
  'package_eligibility',
  'record_type',
  'schema_version',
  'selected_amendment_head_sha256',
  'validation_summary_ref',
  'validation_validity',
  'variant_validation_id',
];

for (const treatment of ['pass', 'fail'] as const) {
  describe(`AC-RUA-025 control pass, treatment ${treatment}`, () => {
    it(`treatment-${treatment}`, async () => {
      const fixture = validationPackage({ control: 'pass', treatment });
      const { summary } = fixture;
      assert.equal(summary.implementation_validation_status, 'verified');
      assert.equal(summary.validation_validity, 'valid');
      assert.equal(summary.validation_terminal_reason, 'COMPLETED');
      assert.deepEqual(summary.status_reasons, []);
      assert.deepEqual(
        summary.trial_results.map((entry) => [entry.sequence, entry.trial_id, entry.scenario, entry.variant_id]),
        [
          [1, CONTROL_TRIAL_ID, 'CONTROL', 'durable'],
          [2, TREATMENT_TRIAL_ID, 'COMMIT_THEN_TIMEOUT', 'durable'],
        ],
      );
      assert.deepEqual(
        summary.trial_results.map((entry) => 'preservation_verdict' in entry && entry.preservation_verdict),
        ['pass', treatment],
      );

      const { verification } = await verifyGolden(fixture, [], null);
      assert.equal(verification.package_eligibility, 'eligible');
      assert.equal(verification.declared_implementation_validation_status, 'verified');
      assert.equal(verification.effective_implementation_validation_status, 'verified');
      assert.equal(verification.validation_validity, 'valid');
      assert.equal(verification.effective_cleanup_status, 'succeeded');
      assert.equal(verification.effective_leak_audit_status, 'clean');
      assert.equal(verification.effective_lease_status, 'released');
      assert.equal(verification.selected_amendment_head_sha256, null);
      assert.equal(verification.operational_recovery_applied, false);
      assert.deepEqual(verification.effective_status_reasons, []);

      // No cross-variant claim: one variant only, no run identity, no comparison member.
      assert.deepEqual(Object.keys(summary).toSorted(), SUMMARY_FIELDS);
      assert.deepEqual(Object.keys(verification).toSorted(), VERIFICATION_FIELDS);
      assert.equal(new Set(summary.trial_results.map((entry) => entry.variant_id)).size, 1);
    });
  });
}
