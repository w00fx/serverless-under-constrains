// AC-RUA-038 golden (design §14 row 038): a run whose original closure was not clean is repaired by
// an OPERATIONAL_RECOVERY amendment in a verified selected chain. The effective operational state is
// clean, yet study completion reads the original package only (BR-RUA-054), so the run stays
// `incomplete` with its original closure values and terminal reason.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { effectiveOperationalState } from '../../../src/evidence-package/effective-operational-state.ts';
import { assessPackageCompletion } from '../../../src/study-comparison/run-package-assessment.ts';
import { readRunPackage } from '../../../src/study-comparison/run-package-reader.ts';
import { loadGoldenCase } from '../_harness/golden-harness.ts';
import { GOLDEN_DEPS, VERIFIED_AT, finalizeGoldenRun, sealGoldenRun, verifyGoldenRun } from './support/golden-run.ts';
import { assertMatchesExpected, assertSchemaValid } from './support/golden-views.ts';
import { recoveryAmendment } from './support/recovery-amendment.ts';
import { BASE_QUALIFICATION } from './support/run-fixture.ts';

const CASES = 'test/golden/study-comparison/cases';

describe('AC-RUA-038 study completion', () => {
  it('recovered-run-not-complete', async () => {
    const loaded = await loadGoldenCase(`${CASES}/recovered-run-not-complete.case.ts`);
    const run = finalizeGoldenRun(loaded.files);
    const summary = run.finalized.run_summary.record;
    assertSchemaValid('run_summary', summary);
    const sealed = sealGoldenRun(run.files);
    const original = {
      cleanup_status: summary.cleanup_status,
      leak_audit_status: summary.leak_audit_status,
      lease_status: summary.lease_status,
    };
    assert.ok(original.cleanup_status !== 'not_started' && original.cleanup_status !== 'running');
    const amendment = recoveryAmendment(
      run.records.execution_manifest.ref.artifact_sha256,
      sealed.package_index_sha256,
      {
        original: { ...original, cleanup_status: original.cleanup_status },
        recovered: { cleanup_status: 'succeeded', leak_audit_status: 'clean', lease_status: 'released' },
      },
    );
    const verification = verifyGoldenRun(sealed.files, [amendment.snapshot], amendment.index_sha256);
    const effective = effectiveOperationalState(
      { verification, original_closure: original, amendments: [amendment.snapshot] },
      GOLDEN_DEPS,
    );
    const read = readRunPackage(sealed.files, GOLDEN_DEPS);
    assert.ok(read.ok);
    const completion = assessPackageCompletion(read.value, {
      original_package_index_sha256: sealed.package_index_sha256,
      package_verification: verification,
      billed_cost_checks: [],
      selected_qualification: BASE_QUALIFICATION,
      assessed_at: VERIFIED_AT,
    });
    assertSchemaValid('study_completion_assessment', completion);
    assertMatchesExpected(loaded, {
      original_summary: {
        run_terminal_reason: summary.run_terminal_reason,
        cleanup_status: summary.cleanup_status,
        leak_audit_status: summary.leak_audit_status,
        lease_status: summary.lease_status,
      },
      recovered_chain: { package_eligibility: verification.package_eligibility, ...effective },
      completion: { ...completion } as unknown as JsonValue,
      incompletion_reason_codes: completion.incompletion_reasons.map((reason) => reason.code),
    });
  });
});
