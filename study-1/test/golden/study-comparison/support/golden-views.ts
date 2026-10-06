// The views a study-comparison golden test compares with its case's `expected` values: each one
// projects a produced record onto the members the case states, so the partial match of the golden
// harness reads them directly. Every produced record is also checked against its catalogue schema.

import assert from 'node:assert/strict';

import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { RecordType } from '../../../../src/record-contract/record-types.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import type { ComparisonAssessment } from '../../../../src/record-contract/records/group-c/comparison_assessment.ts';
import type { RunSummary } from '../../../../src/record-contract/records/group-c/run_summary.ts';
import { UNIT_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import type { RunPackageRecords } from '../../../../src/study-comparison/run-package-reader.ts';
import { expectedMismatches } from '../../_harness/golden-harness.ts';
import type { LoadedGoldenCase } from '../../_harness/golden-harness.ts';
import { GOLDEN_DEPS } from './golden-run.ts';

/**
 * Asserts that `actual` matches every member the case's `expected` names.
 *
 * @example
 * assertMatchesExpected(loaded, { comparison_eligibility: 'eligible' });
 */
export function assertMatchesExpected(loaded: LoadedGoldenCase, actual: JsonValue): void {
  assert.deepEqual(expectedMismatches(loaded.golden_case.expected, actual), [], loaded.case_file);
}

/**
 * Asserts that a produced record is a valid record of its catalogue type.
 *
 * @example
 * assertSchemaValid('run_summary', summary);
 */
export function assertSchemaValid(recordType: RecordType, record: StudyRecord): void {
  const checked = GOLDEN_DEPS.validator.validateAs(recordType, record as unknown as JsonValue);
  assert.equal(checked.valid, true, `${recordType}: ${JSON.stringify(checked.valid ? [] : checked.violations)}`);
}

/**
 * The comparison as AC-RUA-009 and AC-RUA-050 state it.
 *
 * @example
 * comparisonView(assessment).projection_results; // { financial_inputs: 'pass', ... }
 */
export function comparisonView(assessment: ComparisonAssessment): JsonObject {
  const [firstReason] = assessment.comparison_ineligibility_reasons;
  return {
    equality_result: assessment.equality_result,
    projection_results: Object.fromEntries(
      assessment.equality_projections.map((projection) => [projection.projection_id, projection.result]),
    ),
    declared_differences: assessment.equality_projections.flatMap((projection) =>
      projection.differences
        .filter((difference) => difference.declared)
        .map((difference) => ({ projection_id: projection.projection_id, field: difference.field })),
    ),
    comparison_eligibility: assessment.comparison_eligibility,
    comparison_ineligibility_reasons: assessment.comparison_ineligibility_reasons.map((reason) => ({ ...reason })),
    ineligibility_reason: firstReason === undefined ? null : { code: firstReason.code, subject: firstReason.subject },
    failing_checks: assessment.eligibility_checks.filter((check) => !check.holds).map((check) => check.check_id),
  };
}

/**
 * The verdict of each summary entry, in summary order (`null` for a trial without a result).
 *
 * @example
 * summaryVerdicts(summary); // ['pass', 'pass', 'fail', 'fail']
 */
export function summaryVerdicts(summary: RunSummary): JsonValue {
  return summary.trial_results.map((entry) => ('preservation_verdict' in entry ? entry.preservation_verdict : null));
}

/**
 * Asserts that each trial's oracle-result bytes in `loaded` equal those of another committed case:
 * the comparison never rewrites a frozen verdict (AC-RUA-009, AC-RUA-050).
 *
 * @example
 * assertOracleResultsIdentical(loaded, reference, records);
 */
export function assertOracleResultsIdentical(
  loaded: LoadedGoldenCase,
  reference: LoadedGoldenCase,
  records: RunPackageRecords,
): void {
  for (const { trial } of records.trial_records) {
    const path = `trials/${trial.trial_id}/${UNIT_PATHS.oracleResult}`;
    const bytes = loaded.files.get(path);
    assert.ok(bytes !== undefined, `${loaded.case_file} has no ${path}`);
    assert.deepEqual(bytes, reference.files.get(path), `${path} differs from ${reference.case_file}`);
  }
}
