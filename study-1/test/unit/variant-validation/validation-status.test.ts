// BR-RUA-038 status precedence (design §8.15): indeterminate when any acceptance condition is
// unmet; else failed for a trustworthy control `fail`; else verified for a control `pass` with a
// conclusive treatment. With effective closure values, a terminal reason that names only a
// repairable closure is judged by the repaired values (CTR-RUA-004).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ScientificAssessment } from '../../../src/variant-validation/scientific-evidence.ts';
import {
  REPAIRABLE_TERMINAL_REASONS,
  deriveValidationStatus,
} from '../../../src/variant-validation/validation-status.ts';
import type { ValidationStatusInput } from '../../../src/variant-validation/validation-status.ts';
import { validationReason } from '../../../src/variant-validation/validation-reasons.ts';

const SOUND_SCIENCE: ScientificAssessment = {
  validation_validity: 'valid',
  reasons: [],
  control_verdict: 'pass',
  treatment_verdict: 'pass',
};

const SOUND: ValidationStatusInput = {
  scientific: SOUND_SCIENCE,
  terminal_reason: 'COMPLETED',
  closure: { cleanup_status: 'succeeded', leak_audit_status: 'clean', lease_status: 'released' },
  closure_basis: 'declared',
  safety: { standing: 'within_limits' },
  late_evidence_status: 'none',
  evidence_integrity_status: 'verified',
};

function statusOf(overrides: Partial<ValidationStatusInput>): ReturnType<typeof deriveValidationStatus> {
  return deriveValidationStatus({ ...SOUND, ...overrides });
}

function codesOf(overrides: Partial<ValidationStatusInput>): readonly string[] {
  return statusOf(overrides).reasons.map((reason) => reason.code);
}

describe('deriveValidationStatus', () => {
  it('is verified for a control pass with a treatment pass or fail', () => {
    assert.deepEqual(statusOf({}), {
      validation_validity: 'valid',
      implementation_validation_status: 'verified',
      reasons: [],
    });
    const treatmentFail = statusOf({ scientific: { ...SOUND_SCIENCE, treatment_verdict: 'fail' } });
    assert.equal(treatmentFail.implementation_validation_status, 'verified');
  });

  it('is failed for a trustworthy control fail with a conclusive treatment, naming the control failure', () => {
    for (const treatment of ['pass', 'fail'] as const) {
      const status = statusOf({
        scientific: { ...SOUND_SCIENCE, control_verdict: 'fail', treatment_verdict: treatment },
      });
      assert.equal(status.implementation_validation_status, 'failed');
      assert.deepEqual(
        status.reasons.map((reason) => reason.code),
        ['CONTROL_PRESERVATION_FAILED'],
      );
    }
  });

  it('is indeterminate with the scientific reasons and keeps the scientific validity', () => {
    const reason = validationReason('MANIFEST_DRIFT', 'trial 2', 'drift; expected the frozen value');
    const status = statusOf({ scientific: { ...SOUND_SCIENCE, validation_validity: 'invalid', reasons: [reason] } });
    assert.equal(status.implementation_validation_status, 'indeterminate');
    assert.equal(status.validation_validity, 'invalid');
    assert.deepEqual(status.reasons, [reason]);
  });

  it('puts indeterminate before failed: an unmet condition outranks a control fail', () => {
    const status = statusOf({
      scientific: { ...SOUND_SCIENCE, control_verdict: 'fail' },
      closure: { ...SOUND.closure, cleanup_status: 'partial' },
    });
    assert.equal(status.implementation_validation_status, 'indeterminate');
  });

  it('blocks on evidence integrity other than verified', () => {
    for (const value of ['invalid', 'unverified'] as const) {
      assert.deepEqual(codesOf({ evidence_integrity_status: value }), ['EVIDENCE_INTEGRITY_NOT_VERIFIED']);
    }
  });

  it('blocks on contradictory or unverified late evidence and accepts none or consistent', () => {
    assert.deepEqual(codesOf({ late_evidence_status: 'contradictory' }), ['LATE_EVIDENCE_CONTRADICTORY']);
    assert.deepEqual(codesOf({ late_evidence_status: 'unverified' }), ['LATE_EVIDENCE_UNVERIFIED']);
    assert.deepEqual(codesOf({ late_evidence_status: 'consistent' }), []);
  });

  it('blocks on a safety standing with reasons and accepts a pending bill', () => {
    const reason = validationReason('SAFETY_BREACHED', 'safety_status', 'breached; expected within_limits');
    assert.deepEqual(codesOf({ safety: { standing: 'breached', reasons: [reason] } }), ['SAFETY_BREACHED']);
    assert.deepEqual(codesOf({ safety: { standing: 'billing_pending' } }), []);
  });

  it('blocks on every closure value that is not clean, one reason each', () => {
    const codes = codesOf({
      closure: { cleanup_status: 'failed', leak_audit_status: 'unverified', lease_status: 'unverified' },
    });
    assert.deepEqual(codes, ['CLEANUP_NOT_SUCCEEDED', 'LEAK_AUDIT_NOT_CLEAN', 'LEASE_NOT_RELEASED']);
  });

  it('blocks on any terminal reason other than COMPLETED with declared values', () => {
    for (const reason of [...REPAIRABLE_TERMINAL_REASONS, 'LEASE_LOST'] as const) {
      assert.deepEqual(codesOf({ terminal_reason: reason }), ['TERMINAL_REASON_NOT_COMPLETED']);
    }
  });

  it('judges a repairable terminal reason by the effective closure, and keeps every other one', () => {
    for (const reason of REPAIRABLE_TERMINAL_REASONS) {
      assert.deepEqual(codesOf({ terminal_reason: reason, closure_basis: 'effective' }), []);
    }
    for (const reason of ['VALIDATION_INCOMPLETE', 'SAFETY_DEADLINE', 'EVIDENCE_FINALIZATION_FAILED'] as const) {
      assert.deepEqual(codesOf({ terminal_reason: reason, closure_basis: 'effective' }), [
        'TERMINAL_REASON_NOT_COMPLETED',
      ]);
    }
  });

  it('names the inconclusive verdict when a caller-built assessment omits its reasons', () => {
    const missingTreatment = statusOf({ scientific: { ...SOUND_SCIENCE, treatment_verdict: undefined } });
    assert.equal(missingTreatment.implementation_validation_status, 'indeterminate');
    assert.deepEqual(
      missingTreatment.reasons.map((reason) => reason.code),
      ['TREATMENT_VERDICT_INDETERMINATE'],
    );
    assert.match(missingTreatment.reasons[0]?.detail ?? '', /treatment verdict absent/);

    const failedControl = statusOf({
      scientific: { ...SOUND_SCIENCE, control_verdict: 'fail', treatment_verdict: 'indeterminate' },
    });
    assert.deepEqual(
      failedControl.reasons.map((reason) => reason.code),
      ['TREATMENT_VERDICT_INDETERMINATE'],
    );

    const noControl = statusOf({ scientific: { ...SOUND_SCIENCE, control_verdict: 'indeterminate' } });
    assert.deepEqual(
      noControl.reasons.map((reason) => reason.code),
      ['CONTROL_VERDICT_INDETERMINATE'],
    );
    const absentControl = statusOf({ scientific: { ...SOUND_SCIENCE, control_verdict: undefined } });
    assert.match(absentControl.reasons[0]?.detail ?? '', /control verdict absent/);
  });
});
