// Comparison eligibility (BR-RUA-031, BR-RUA-052): eligible iff all nine conditions hold; each
// condition holds exactly when it has no reason, and the ineligibility reasons are their union with
// each reason once. A verdict is never read: `pass` and `fail` are both comparable.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { StructuredReason, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { LeakedResource } from '../../../src/record-contract/records/group-c/leak_audit_result.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { comparisonReason } from '../../../src/study-comparison/comparison-reasons.ts';
import { deriveComparisonEligibility } from '../../../src/study-comparison/comparison-eligibility.ts';
import type { ComparisonEligibilityInput } from '../../../src/study-comparison/comparison-eligibility.ts';
import { evaluateEquality } from '../../../src/study-comparison/equality-evaluation.ts';
import { missingOracleResultReason } from '../../../src/study-comparison/run-evidence-integrity.ts';
import { cleanRunRecords } from './support/clean-run.ts';
import { slotInputs } from './support/equality-inputs.ts';
import { editResult, resultsOf } from './support/frozen-results.ts';

let clean: ComparisonEligibilityInput;
let controlId: Uuid4;
let treatmentId: Uuid4;

before(async () => {
  const records = await cleanRunRecords();
  const { trials } = records.execution_manifest.record;
  controlId = trials[0].trial_id;
  treatmentId = trials[3].trial_id;
  clean = {
    trials,
    oracle_results: resultsOf(records),
    equality: evaluateEquality(slotInputs(), []),
    evidence_integrity: { status: 'verified', reasons: [] },
    late_evidence: records.late_evidence,
    contradictory_amendments: [],
    leak_audit: records.leak_audit,
  };
});

function failing(input: ComparisonEligibilityInput): readonly string[] {
  return deriveComparisonEligibility(input)
    .checks.filter((check) => !check.holds)
    .map((check) => check.check_id);
}

function withLeak(input: ComparisonEligibilityInput, leak: LeakedResource): ComparisonEligibilityInput {
  const audit = input.leak_audit;
  assert.ok(audit !== undefined);
  return {
    ...input,
    leak_audit: { ...audit, record: { ...audit.record, leak_audit_status: 'leaks_detected', leaks: [leak] } },
  };
}

const LEAK = {
  resource_type: 'AWS::SQS::Queue',
  identifier: 'suc1-b42ee7a8-durable-source.fifo',
  surface: 'tag_index',
  ownership_basis: 'recorded_stack',
} as const;

describe('deriveComparisonEligibility', () => {
  it('is eligible with nine holding checks in their fixed order', () => {
    const eligibility = deriveComparisonEligibility(clean);
    assert.equal(eligibility.comparison_eligibility, 'eligible');
    assert.deepEqual(eligibility.comparison_ineligibility_reasons, []);
    assert.deepEqual(
      eligibility.checks.map((check) => [check.check_id, check.holds, check.reasons.length]),
      [
        ['FOUR_ORACLE_RESULTS', true, 0],
        ['ALL_TRIALS_VALID', true, 0],
        ['CONTROLS_VERIFIED', true, 0],
        ['TREATMENTS_VERIFIED', true, 0],
        ['EQUALITY_PASSES', true, 0],
        ['EVIDENCE_INTEGRITY_VERIFIED', true, 0],
        ['LATE_EVIDENCE_ACCEPTABLE', true, 0],
        ['NO_CONTRADICTORY_AMENDMENT', true, 0],
        ['NO_ISOLATION_COMPROMISING_LEAK', true, 0],
      ],
    );
  });

  it('stays eligible whatever the verdicts are', () => {
    const verdicts = clean.trials.map((trial) => clean.oracle_results.get(trial.trial_id)?.record.preservation_verdict);
    assert.deepEqual(verdicts, ['pass', 'pass', 'fail', 'fail']);
    assert.equal(deriveComparisonEligibility(clean).comparison_eligibility, 'eligible');
  });

  it('lists a missing oracle result once although four conditions repeat it', () => {
    const eligibility = deriveComparisonEligibility({
      ...clean,
      oracle_results: editResult(clean.oracle_results, controlId, null),
    });
    assert.deepEqual(
      eligibility.checks.filter((check) => !check.holds).map((check) => check.check_id),
      ['FOUR_ORACLE_RESULTS', 'ALL_TRIALS_VALID', 'CONTROLS_VERIFIED'],
    );
    assert.deepEqual(eligibility.comparison_ineligibility_reasons, [missingOracleResultReason(controlId)]);
  });

  it('fails ALL_TRIALS_VALID for a trial that is not valid', () => {
    const results = editResult(clean.oracle_results, treatmentId, (record) => ({
      ...record,
      trial_validity: 'indeterminate',
    }));
    const eligibility = deriveComparisonEligibility({ ...clean, oracle_results: results });
    assert.deepEqual(failing({ ...clean, oracle_results: results }), ['ALL_TRIALS_VALID']);
    assert.deepEqual(
      eligibility.comparison_ineligibility_reasons.map(({ code, subject }) => [code, subject]),
      [['TRIAL_NOT_VALID', treatmentId]],
    );
  });

  it('fails CONTROLS_VERIFIED and TREATMENTS_VERIFIED for unverified integrity or fidelity', () => {
    const control = editResult(clean.oracle_results, controlId, (record) =>
      record.scenario === 'CONTROL' ? { ...record, control_integrity: 'unverified' } : record,
    );
    assert.deepEqual(failing({ ...clean, oracle_results: control }), ['CONTROLS_VERIFIED']);
    const treatment = editResult(clean.oracle_results, treatmentId, (record) =>
      record.scenario === 'COMMIT_THEN_TIMEOUT' ? { ...record, treatment_fidelity: 'invalid' } : record,
    );
    const eligibility = deriveComparisonEligibility({ ...clean, oracle_results: treatment });
    assert.deepEqual(failing({ ...clean, oracle_results: treatment }), ['TREATMENTS_VERIFIED']);
    assert.match(
      eligibility.comparison_ineligibility_reasons[0]?.detail ?? '',
      /has treatment_fidelity invalid; expected verified$/,
    );
  });

  it('fails EQUALITY_PASSES with the equality reasons', () => {
    const equality = evaluateEquality(
      slotInputs({ observation_window: (slot) => ({ common: { deadline: slot } }) }),
      [],
    );
    const eligibility = deriveComparisonEligibility({ ...clean, equality });
    assert.deepEqual(failing({ ...clean, equality }), ['EQUALITY_PASSES']);
    assert.deepEqual(eligibility.comparison_ineligibility_reasons, equality.reasons);
  });

  it('fails EVIDENCE_INTEGRITY_VERIFIED with the integrity reasons', () => {
    const reason = comparisonReason('CROSS_TRIAL_IDENTITY_REUSE', 'tx', 'reused');
    assert.deepEqual(failing({ ...clean, evidence_integrity: { status: 'invalid', reasons: [reason] } }), [
      'EVIDENCE_INTEGRITY_VERIFIED',
    ]);
  });

  it('accepts none or consistent late evidence and rejects the rest', () => {
    const late = clean.late_evidence;
    assert.ok(late !== undefined);
    const complete = (status: 'none' | 'consistent' | 'contradictory'): ComparisonEligibilityInput => ({
      ...clean,
      late_evidence: { ...late, record: { ...late.record, monitoring: 'complete', late_evidence_status: status } },
    });
    const shortened: ComparisonEligibilityInput = {
      ...clean,
      late_evidence: {
        ...late,
        record: { ...late.record, monitoring: 'shortened', late_evidence_status: 'unverified' },
      },
    };
    assert.deepEqual(failing(complete('consistent')), []);
    for (const rejected of [complete('contradictory'), shortened]) {
      const reasons = deriveComparisonEligibility(rejected).comparison_ineligibility_reasons;
      assert.deepEqual(
        reasons.map(({ code, subject }) => [code, subject]),
        [['LATE_EVIDENCE_NOT_ACCEPTABLE', 'late_evidence_status']],
      );
    }
  });

  it('fails LATE_EVIDENCE_ACCEPTABLE when the assessment is absent', () => {
    const reasons = deriveComparisonEligibility({
      ...clean,
      late_evidence: undefined,
    }).comparison_ineligibility_reasons;
    assert.deepEqual(
      reasons.map(({ code, artifact_path }) => [code, artifact_path]),
      [['ARTIFACT_MISSING', EXECUTION_PATHS.lateEvidenceAssessment]],
    );
  });

  it('re-codes each contradictory amendment reason as CONTRADICTORY_AMENDMENT', () => {
    const chain: StructuredReason = {
      code: 'CONTRADICTORY_CHAIN',
      subject: 'BR-RUA-043',
      artifact_path: 'amendments/x',
      detail: 'two heads',
    };
    const reasons = deriveComparisonEligibility({
      ...clean,
      contradictory_amendments: [chain],
    }).comparison_ineligibility_reasons;
    assert.deepEqual(reasons, [
      { code: 'CONTRADICTORY_AMENDMENT', subject: 'BR-RUA-043', artifact_path: 'amendments/x', detail: 'two heads' },
    ]);
  });

  it('stays eligible for leaks that cannot process (storage_only, identity)', () => {
    for (const capability of ['storage_only', 'identity'] as const) {
      assert.deepEqual(failing(withLeak(clean, { ...LEAK, capability_class: capability })), [], capability);
    }
  });

  it('is ineligible for a processing_capable or unknown leak, naming the resource', () => {
    for (const capability of ['processing_capable', 'unknown'] as const) {
      const reasons = deriveComparisonEligibility(
        withLeak(clean, { ...LEAK, capability_class: capability }),
      ).comparison_ineligibility_reasons;
      assert.deepEqual(
        reasons.map(({ code, subject }) => [code, subject]),
        [['ISOLATION_COMPROMISING_LEAK', LEAK.identifier]],
      );
      assert.match(
        reasons[0]?.detail ?? '',
        new RegExp(`is ${capability}; expected no processing_capable or unknown leak`),
      );
    }
  });

  it('fails NO_ISOLATION_COMPROMISING_LEAK when the audit is absent', () => {
    const reasons = deriveComparisonEligibility({ ...clean, leak_audit: undefined }).comparison_ineligibility_reasons;
    assert.deepEqual(
      reasons.map(({ code, subject }) => [code, subject]),
      [['ARTIFACT_MISSING', 'leak_audit']],
    );
  });
});
