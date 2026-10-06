// AC-RUA-050 goldens (design §14 row 050): an operational closure failure is reported in its own
// fields and never rewrites a frozen verdict. A `storage_only` leak leaves the comparison eligible;
// a `processing_capable` leak could still produce correlated effects, so the comparison is
// ineligible. In both, the four oracle results are byte-identical to the clean case.

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
const REFERENCE_CASE = 'ac009-all-projections-equal';

async function assertIndependentClosure(caseId: string): Promise<void> {
  const loaded = await loadGoldenCase(`${CASES}/${caseId}.case.ts`);
  const reference = await loadGoldenCase(`${CASES}/${REFERENCE_CASE}.case.ts`);
  const run = finalizeGoldenRun(loaded.files);
  const assessment = run.finalized.comparison_assessment.record;
  const summary = run.finalized.run_summary.record;
  assertSchemaValid('comparison_assessment', assessment);
  assertSchemaValid('run_summary', summary);
  assertOracleResultsIdentical(loaded, reference, run.records);
  assertMatchesExpected(loaded, {
    ...comparisonView(assessment),
    cleanup_status: summary.cleanup_status,
    leak_audit_status: summary.leak_audit_status,
    verdicts: summaryVerdicts(summary),
    oracle_results_identical_to: REFERENCE_CASE,
  });
}

describe('AC-RUA-050 operational independence', () => {
  it('cleanup-failure-without-compromise', async () => {
    await assertIndependentClosure('cleanup-failure-without-compromise');
  });

  it('leak-capable-of-correlated-effects', async () => {
    await assertIndependentClosure('leak-capable-of-correlated-effects');
  });
});
