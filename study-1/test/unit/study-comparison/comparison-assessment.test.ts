// The comparison_assessment record (design §6.2 row 73): equality and eligibility in one record that
// cites the oracle results it read, in declared order, and never copies a verdict.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { assessRunComparison, eligibilityOutcome } from '../../../src/study-comparison/comparison-assessment.ts';
import type { RunComparisonInput } from '../../../src/study-comparison/comparison-assessment.ts';
import { comparisonReason } from '../../../src/study-comparison/comparison-reasons.ts';
import { assertSchemaValid } from '../../golden/study-comparison/support/golden-views.ts';
import { cleanRunRecords } from './support/clean-run.ts';
import { VISIBILITY_DIFFERENCE, slotInputs } from './support/equality-inputs.ts';
import { editResult, resultsOf } from './support/frozen-results.ts';

let input: RunComparisonInput;

before(async () => {
  const records = await cleanRunRecords();
  const manifest = records.execution_manifest;
  input = {
    run_id: records.run_id,
    execution_manifest_sha256: manifest.ref.artifact_sha256,
    trials: manifest.record.trials,
    declared_variant_differences: [VISIBILITY_DIFFERENCE],
    trial_inputs: slotInputs(),
    oracle_results: resultsOf(records),
    late_evidence: records.late_evidence,
    leak_audit: records.leak_audit,
    contradictory_amendments: [],
    assessed_at: '2026-10-05T13:15:00.000Z' as UtcMillis,
  };
});

describe('assessRunComparison', () => {
  it('builds a schema-valid eligible assessment citing the four results in declared order', () => {
    const { assessment, evidence_integrity } = assessRunComparison(input);
    assertSchemaValid('comparison_assessment', assessment);
    assert.equal(assessment.comparison_eligibility, 'eligible');
    assert.equal(assessment.equality_result, 'pass');
    assert.deepEqual(
      assessment.oracle_result_refs,
      input.trials.map((trial) => input.oracle_results.get(trial.trial_id)?.ref),
    );
    assert.deepEqual(evidence_integrity, { status: 'verified', reasons: [] });
    assert.ok(!('preservation_verdict' in assessment));
  });

  it('cites only the results that exist and is ineligible without one', () => {
    const missing = input.trials[2]?.trial_id;
    assert.ok(missing !== undefined);
    const { assessment, evidence_integrity } = assessRunComparison({
      ...input,
      oracle_results: editResult(input.oracle_results, missing, null),
    });
    assertSchemaValid('comparison_assessment', assessment);
    assert.equal(assessment.oracle_result_refs.length, 3);
    assert.equal(assessment.comparison_eligibility, 'ineligible');
    assert.equal(evidence_integrity.status, 'unverified');
  });
});

describe('eligibilityOutcome', () => {
  it('keeps only the outcome and its reasons', () => {
    const reason = comparisonReason('UNDECLARED_DIFFERENCE', 'a.b', 'differs');
    assert.deepEqual(
      eligibilityOutcome({ comparison_eligibility: 'ineligible', comparison_ineligibility_reasons: [reason] }),
      { comparison_eligibility: 'ineligible', comparison_ineligibility_reasons: [reason] },
    );
    assert.deepEqual(eligibilityOutcome({ comparison_eligibility: 'eligible', comparison_ineligibility_reasons: [] }), {
      comparison_eligibility: 'eligible',
      comparison_ineligibility_reasons: [],
    });
  });
});
