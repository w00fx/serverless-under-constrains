// AC-RUA-012 and AC-RUA-027 goldens (design §14 rows 012 and 027): the run summary reports all four
// trials exactly as their oracle results froze them, even when the evidence contradicts the initial
// hypothesis; and a clean canonical run whose treatments fail is still eligible and completes the
// study, its sealed package verified by the package verifier.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { assessPackageCompletion } from '../../../src/study-comparison/run-package-assessment.ts';
import { readRunPackage } from '../../../src/study-comparison/run-package-reader.ts';
import { loadGoldenCase } from '../_harness/golden-harness.ts';
import { BASE_QUALIFICATION } from './support/run-fixture.ts';
import { GOLDEN_DEPS, VERIFIED_AT, finalizeGoldenRun, sealGoldenRun, verifyGoldenRun } from './support/golden-run.ts';
import { assertMatchesExpected, assertSchemaValid, summaryVerdicts } from './support/golden-views.ts';

const CASES = 'test/golden/study-comparison/cases';

describe('AC-RUA-012 and AC-RUA-027 run summary', () => {
  it('ac012-summary-includes-all-four', async () => {
    const loaded = await loadGoldenCase(`${CASES}/ac012-summary-includes-all-four.case.ts`);
    const run = finalizeGoldenRun(loaded.files);
    const summary = run.finalized.run_summary.record;
    assertSchemaValid('run_summary', summary);
    // Each entry is its oracle result's verdict and completion, copied, and cites those exact bytes.
    const cited = summary.trial_results.map((entry) => [
      entry.trial_id,
      'oracle_result_ref' in entry ? entry.oracle_result_ref : null,
    ]);
    const frozen = run.records.trial_records.map((trial) => [trial.trial.trial_id, trial.oracle_result?.ref ?? null]);
    assert.deepEqual(cited, frozen);
    assertMatchesExpected(loaded, {
      trial_results: summary.trial_results.map((entry) => ({ ...entry }) as unknown as JsonValue),
      summary_members: Object.keys(summary).sort(),
      trial_result_members: [...new Set(summary.trial_results.flatMap((entry) => Object.keys(entry)))].sort(),
    });
  });

  it('ac027-four-cell-completion', async () => {
    const loaded = await loadGoldenCase(`${CASES}/ac027-four-cell-completion.case.ts`);
    const run = finalizeGoldenRun(loaded.files);
    const summary = run.finalized.run_summary.record;
    assertSchemaValid('run_summary', summary);
    const sealed = sealGoldenRun(run.files);
    const verification = verifyGoldenRun(sealed.files, [], null);
    const original = readRunPackage(sealed.files, GOLDEN_DEPS);
    assert.ok(original.ok);
    const completion = assessPackageCompletion(original.value, {
      original_package_index_sha256: sealed.package_index_sha256,
      package_verification: verification,
      billed_cost_checks: [],
      selected_qualification: BASE_QUALIFICATION,
      assessed_at: VERIFIED_AT,
    });
    assertSchemaValid('study_completion_assessment', completion);
    assertMatchesExpected(loaded, {
      summary: { ...summary } as unknown as JsonValue,
      verdicts: summaryVerdicts(summary),
      package_eligibility: verification.package_eligibility,
      completion: { ...completion } as unknown as JsonValue,
    });
  });
});
