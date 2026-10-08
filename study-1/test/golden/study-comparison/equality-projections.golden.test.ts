// AC-RUA-009 golden (design §14 row 009): the BR-RUA-007 equality projections over four frozen
// trials. Every projection passing with only the declared source-visibility difference gives an
// eligible comparison; one undeclared difference makes it ineligible while the four oracle results
// stay byte-identical to the eligible case.

import { describe, it } from 'node:test';

import { loadGoldenCase } from '../_harness/golden-harness.ts';
import { finalizeGoldenRun } from './support/golden-run.ts';
import {
  assertMatchesExpected,
  assertOracleResultsIdentical,
  assertSchemaValid,
  comparisonView,
  summaryVerdicts,
} from './support/golden-views.ts';

const CASES = 'test/golden/study-comparison/cases';

describe('AC-RUA-009 equality between variants', () => {
  it('ac009-all-projections-equal', async () => {
    const loaded = await loadGoldenCase(`${CASES}/ac009-all-projections-equal.case.ts`);
    const run = finalizeGoldenRun(loaded.files);
    const assessment = run.finalized.comparison_assessment.record;
    assertSchemaValid('comparison_assessment', assessment);
    assertMatchesExpected(loaded, {
      ...comparisonView(assessment),
      verdicts: summaryVerdicts(run.finalized.run_summary.record),
    });
  });

  it('ac009-undeclared-difference', async () => {
    const loaded = await loadGoldenCase(`${CASES}/ac009-undeclared-difference.case.ts`);
    const reference = await loadGoldenCase(`${CASES}/ac009-all-projections-equal.case.ts`);
    const run = finalizeGoldenRun(loaded.files);
    const assessment = run.finalized.comparison_assessment.record;
    assertSchemaValid('comparison_assessment', assessment);
    assertSchemaValid('run_summary', run.finalized.run_summary.record);
    assertOracleResultsIdentical(loaded, reference, run.records);
    assertMatchesExpected(loaded, {
      ...comparisonView(assessment),
      verdicts: summaryVerdicts(run.finalized.run_summary.record),
      oracle_results_identical_to: 'ac009-all-projections-equal',
    });
  });
});
