// BR-RUA-038 precedence as a property (design §8.15; Owner amendment A-11): over every combination
// of scientific, safety, late-evidence, integrity, terminal-reason and closure values, the derived
// status equals an oracle written here from the rule text, independently of validation-status.ts:
//
//   indeterminate  if any acceptance condition is unmet;
//   failed         elif the control verdict is fail and the treatment verdict is pass or fail;
//   verified       elif the control verdict is pass and the treatment verdict is pass or fail.
//
// Effective values may repair only cleanup, leak-audit and lease closure (CTR-RUA-004), so a
// scientific reason keeps the status indeterminate whatever the closure.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { VALIDATION_TERMINAL_REASONS } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import type { PreservationVerdict } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import type { SafetyStanding } from '../../../src/variant-validation/safety-standing.ts';
import { deriveValidationStatus } from '../../../src/variant-validation/validation-status.ts';
import type { ValidationStatusInput } from '../../../src/variant-validation/validation-status.ts';
import { validationReason } from '../../../src/variant-validation/validation-reasons.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const VERDICTS: readonly (PreservationVerdict | undefined)[] = ['pass', 'fail', 'indeterminate', undefined];
const CLOSURE_ONLY = new Set([
  'CLEANUP_INCOMPLETE',
  'LEAK_AUDIT_NOT_CLEAN',
  'LEASE_RELEASE_FAILED',
  'LEASE_STATE_UNVERIFIED',
]);
const SCIENTIFIC_REASON = validationReason('MANIFEST_DRIFT', 'trial 2', 'drift; expected the frozen value');
const SAFETY_REASON = validationReason('SAFETY_BREACHED', 'safety_status', 'breached; expected within limits');

const safetyArbitrary: fc.Arbitrary<SafetyStanding> = fc.constantFrom<SafetyStanding>(
  { standing: 'within_limits' },
  { standing: 'billing_pending' },
  { standing: 'breached', reasons: [SAFETY_REASON] },
  { standing: 'unverified', reasons: [SAFETY_REASON] },
);

const inputArbitrary: fc.Arbitrary<ValidationStatusInput> = fc.record({
  scientific: fc.record({
    validation_validity: fc.constantFrom('valid', 'invalid', 'indeterminate'),
    reasons: fc.constantFrom([], [SCIENTIFIC_REASON]),
    control_verdict: fc.constantFrom(...VERDICTS),
    treatment_verdict: fc.constantFrom(...VERDICTS),
  }),
  terminal_reason: fc.constantFrom(...VALIDATION_TERMINAL_REASONS),
  closure: fc.record({
    cleanup_status: fc.constantFrom('succeeded', 'partial', 'failed', 'unverified'),
    leak_audit_status: fc.constantFrom('clean', 'leaks_detected', 'inconclusive', 'unverified'),
    lease_status: fc.constantFrom('released', 'recovery_required', 'unverified'),
  }),
  closure_basis: fc.constantFrom('declared', 'effective'),
  safety: safetyArbitrary,
  late_evidence_status: fc.constantFrom('none', 'consistent', 'contradictory', 'unverified'),
  evidence_integrity_status: fc.constantFrom('verified', 'invalid', 'unverified'),
});

/** The oracle: is any BR-RUA-038 acceptance condition unmet? */
function anyConditionUnmet(input: ValidationStatusInput): boolean {
  const terminalUnmet =
    input.terminal_reason !== 'COMPLETED' &&
    !(input.closure_basis === 'effective' && CLOSURE_ONLY.has(input.terminal_reason));
  return (
    input.scientific.reasons.length > 0 ||
    input.evidence_integrity_status !== 'verified' ||
    !['none', 'consistent'].includes(input.late_evidence_status) ||
    input.safety.standing === 'breached' ||
    input.safety.standing === 'unverified' ||
    terminalUnmet ||
    input.closure.cleanup_status !== 'succeeded' ||
    input.closure.leak_audit_status !== 'clean' ||
    input.closure.lease_status !== 'released'
  );
}

function expectedStatus(input: ValidationStatusInput): 'verified' | 'failed' | 'indeterminate' {
  const treatmentConclusive =
    input.scientific.treatment_verdict === 'pass' || input.scientific.treatment_verdict === 'fail';
  if (anyConditionUnmet(input) || !treatmentConclusive) {
    return 'indeterminate';
  }
  if (input.scientific.control_verdict === 'fail') {
    return 'failed';
  }
  return input.scientific.control_verdict === 'pass' ? 'verified' : 'indeterminate';
}

describe('deriveValidationStatus (property)', () => {
  it('equals the BR-RUA-038 precedence oracle and always explains a non-verified status', () => {
    fc.assert(
      fc.property(inputArbitrary, (input) => {
        const status = deriveValidationStatus(input);
        assert.equal(status.implementation_validation_status, expectedStatus(input));
        assert.equal(status.validation_validity, input.scientific.validation_validity);
        assert.equal(status.reasons.length === 0, status.implementation_validation_status === 'verified');
      }),
      fuzzParameters(),
    );
  });

  it('never lets repaired closure values conclude a validation with a scientific reason', () => {
    fc.assert(
      fc.property(inputArbitrary, (input) => {
        const repaired: ValidationStatusInput = {
          ...input,
          scientific: { ...input.scientific, reasons: [SCIENTIFIC_REASON] },
          closure: { cleanup_status: 'succeeded', leak_audit_status: 'clean', lease_status: 'released' },
          closure_basis: 'effective',
        };
        const status = deriveValidationStatus(repaired);
        assert.equal(status.implementation_validation_status, 'indeterminate');
        assert.ok(status.reasons.includes(SCIENTIFIC_REASON));
      }),
      fuzzParameters(),
    );
  });
});
