// Canonical study completion (BR-RUA-054, AC-RUA-027, AC-RUA-038): `complete` iff every status value
// of the ORIGINAL package is exactly the BR-RUA-054 value and all seven checks hold; otherwise
// `incomplete` with the original values and every reason, each once.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { Sha256Hex, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { PackageVerification } from '../../../src/record-contract/records/group-c/package_verification.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { assessStudyCompletion } from '../../../src/study-comparison/study-completion.ts';
import type { StudyCompletionInput } from '../../../src/study-comparison/study-completion.ts';
import { sealGoldenRun, verifyGoldenRun } from '../../golden/study-comparison/support/golden-run.ts';
import { assertSchemaValid } from '../../golden/study-comparison/support/golden-views.ts';
import { BASE_QUALIFICATION } from '../../golden/study-comparison/support/run-fixture.ts';
import { cleanRunFiles, cleanRunRecords } from './support/clean-run.ts';

let clean: StudyCompletionInput;

before(async () => {
  const sealed = sealGoldenRun(await cleanRunFiles());
  const records = await cleanRunRecords();
  clean = {
    run_id: records.run_id,
    original_package_index_sha256: sealed.package_index_sha256,
    package_verification: verifyGoldenRun(sealed.files, [], null),
    execution_manifest: records.execution_manifest,
    run_summary: records.run_summary,
    comparison_assessment: records.comparison_assessment,
    leak_audit: records.leak_audit,
    source_provenance: records.source_provenance,
    billed_cost_checks: ['within_limit'],
    selected_qualification: BASE_QUALIFICATION,
    assessed_at: '2026-10-06T09:00:00.000Z' as UtcMillis,
  };
});

function assess(patch: Partial<StudyCompletionInput>): ReturnType<typeof assessStudyCompletion> {
  const completion = assessStudyCompletion({ ...clean, ...patch });
  assertSchemaValid('study_completion_assessment', completion);
  return completion;
}

function codes(completion: ReturnType<typeof assessStudyCompletion>): readonly string[] {
  return completion.incompletion_reasons.map(({ code, subject }) => `${code}:${subject}`);
}

function failing(completion: ReturnType<typeof assessStudyCompletion>): readonly string[] {
  return completion.checks.filter((check) => !check.holds).map((check) => check.check_id);
}

// The clean summary with some members replaced; the patch is untyped, so the result is checked
// against the run_summary schema before a test uses it.
function summaryWith(patch: Readonly<Record<string, unknown>>): StudyCompletionInput['run_summary'] {
  const summary = clean.run_summary;
  assert.ok(summary !== undefined);
  const record = { ...summary.record, ...patch } as typeof summary.record;
  assertSchemaValid('run_summary', record);
  return { ...summary, record };
}

describe('assessStudyCompletion', () => {
  it('is complete for a clean original package, citing what it read in that package', () => {
    const completion = assess({});
    assert.equal(completion.study_completion, 'complete');
    assert.deepEqual(failing(completion), []);
    assert.equal(completion.checks.length, 7);
    assert.ok(
      completion.evidence_refs.every((ref) => ref.package_index_sha256 === clean.original_package_index_sha256),
    );
    assert.deepEqual(
      completion.evidence_refs.map((ref) => ref.artifact_path),
      [
        EXECUTION_PATHS.executionManifest,
        EXECUTION_PATHS.sourceProvenance,
        EXECUTION_PATHS.leakAuditResult,
        EXECUTION_PATHS.comparisonAssessment,
        EXECUTION_PATHS.runSummary,
      ].toSorted(),
    );
  });

  it('falls back to not-established values without a summary', () => {
    const completion = assess({ run_summary: undefined });
    assert.equal(completion.study_completion, 'incomplete');
    assert.deepEqual(
      [
        completion.comparison_eligibility,
        completion.cleanup_status,
        completion.leak_audit_status,
        completion.lease_status,
        completion.run_terminal_reason,
      ],
      ['ineligible', 'not_started', 'inconclusive', 'unverified', 'EVIDENCE_FINALIZATION_FAILED'],
    );
    assert.deepEqual(failing(completion), [
      'FOUR_ORACLE_RESULTS',
      'EVIDENCE_INTEGRITY_VERIFIED',
      'NO_KNOWN_SAFETY_BREACH',
    ]);
    assert.equal(codes(completion).filter((code) => code === 'ARTIFACT_MISSING:run_summary').length, 1);
  });

  it('is incomplete when the package verification is ineligible', () => {
    const verification: PackageVerification = {
      ...clean.package_verification,
      package_eligibility: 'ineligible',
      package_ineligibility_reasons: [{ code: 'ALTERED_BYTES', subject: 'x', detail: 'changed' }],
    };
    const completion = assess({ package_verification: verification });
    assert.equal(completion.package_eligibility, 'ineligible');
    assert.deepEqual(codes(completion), ['PACKAGE_NOT_ELIGIBLE:package_eligibility']);
    assert.match(
      completion.incompletion_reasons.map((reason) => reason.detail).join('\n'),
      /is ineligible with ALTERED_BYTES;/,
    );
  });

  it('is incomplete when the verification is of another package', () => {
    const other = 'e'.repeat(64) as Sha256Hex;
    const completion = assess({ original_package_index_sha256: other });
    assert.equal(completion.package_eligibility, 'ineligible');
    assert.match(
      completion.incompletion_reasons.map((reason) => reason.detail).join('\n'),
      new RegExp(`of package index [0-9a-f]{64}, not ${other};`),
    );
  });

  it('reports a contradictory amendment chain the verifier found', () => {
    const verification: PackageVerification = {
      ...clean.package_verification,
      package_eligibility: 'ineligible',
      package_ineligibility_reasons: [
        { code: 'CONTRADICTORY_CHAIN', subject: 'BR-RUA-043', detail: 'two recoveries disagree' },
      ],
    };
    const completion = assess({ package_verification: verification });
    assert.deepEqual(failing(completion), ['NO_CONTRADICTORY_AMENDMENT']);
    assert.ok(codes(completion).includes('CONTRADICTORY_AMENDMENT:BR-RUA-043'));
  });

  it('names each original closure value that is not the BR-RUA-054 value', () => {
    const completion = assess({
      run_summary: summaryWith({
        comparison_eligibility: 'ineligible',
        comparison_ineligibility_reasons: [{ code: 'UNDECLARED_DIFFERENCE', subject: 'a.b', detail: 'differs' }],
        cleanup_status: 'partial',
        leak_audit_status: 'inconclusive',
        lease_status: 'unverified',
        run_terminal_reason: 'CLEANUP_INCOMPLETE',
      }),
    });
    assert.deepEqual(codes(completion), [
      'COMPARISON_NOT_ELIGIBLE:comparison_eligibility',
      'CLOSURE_NOT_CLEAN:cleanup_status',
      'CLOSURE_NOT_CLEAN:leak_audit_status',
      'CLOSURE_NOT_CLEAN:lease_status',
      'RUN_NOT_COMPLETED:run_terminal_reason',
    ]);
    assert.match(completion.incompletion_reasons[1]?.detail ?? '', /has cleanup_status partial; expected succeeded$/);
  });

  it('fails FOUR_ORACLE_RESULTS for a summary entry without a result', () => {
    const summary = clean.run_summary;
    assert.ok(summary !== undefined);
    const [first, second, third, fourth] = summary.record.trial_results;
    const { trial_id, sequence, variant_id, scenario } = fourth;
    const unfrozen = {
      trial_id,
      sequence,
      variant_id,
      scenario,
      execution_status: 'incomplete',
      incompletion_reasons: [{ code: 'TRIAL_NOT_FROZEN', subject: trial_id, detail: 'absent' }],
    };
    const completion = assess({
      run_summary: summaryWith({
        trial_results: [first, second, third, unfrozen],
        execution_status: 'incomplete',
        comparison_eligibility: 'ineligible',
        comparison_ineligibility_reasons: [
          { code: 'ORACLE_RESULT_MISSING', subject: fourth.trial_id, detail: 'absent' },
        ],
        evidence_integrity_status: 'unverified',
        run_terminal_reason: 'TRIAL_INCOMPLETE',
      }),
    });
    assert.deepEqual(failing(completion), ['FOUR_ORACLE_RESULTS', 'EVIDENCE_INTEGRITY_VERIFIED']);
    assert.ok(codes(completion).includes(`ORACLE_RESULT_MISSING:${fourth.trial_id}`));
    assert.ok(codes(completion).includes('EVIDENCE_INTEGRITY_NOT_VERIFIED:evidence_integrity_status'));
  });

  it('fails EQUALITY_EVALUATED for an indeterminate or absent comparison', () => {
    const comparison = clean.comparison_assessment;
    assert.ok(comparison !== undefined);
    const indeterminate = assess({
      comparison_assessment: { ...comparison, record: { ...comparison.record, equality_result: 'indeterminate' } },
    });
    assert.deepEqual(failing(indeterminate), ['EQUALITY_EVALUATED']);
    assert.deepEqual(codes(indeterminate), ['EQUALITY_NOT_EVALUATED:equality_result']);
    const failed = assess({
      comparison_assessment: { ...comparison, record: { ...comparison.record, equality_result: 'fail' } },
    });
    assert.deepEqual(failing(failed), []);
    assert.deepEqual(codes(assess({ comparison_assessment: undefined })), ['ARTIFACT_MISSING:equality_result']);
  });

  it('fails NO_KNOWN_SAFETY_BREACH for a breached summary or billed-cost check', () => {
    const breached = assess({ run_summary: summaryWith({ safety_status: 'breached' }) });
    assert.deepEqual(codes(breached), ['KNOWN_SAFETY_BREACH:safety_status']);
    const billed = assess({ billed_cost_checks: ['within_limit', 'breached'] });
    assert.deepEqual(codes(billed), ['KNOWN_SAFETY_BREACH:billed_cost_check']);
    assert.deepEqual(failing(assess({ billed_cost_checks: ['unverified'] })), []);
  });

  it('fails NO_REMAINING_OWNED_RESOURCE for any leak, or an absent audit', () => {
    const audit = clean.leak_audit;
    assert.ok(audit !== undefined);
    const leak = {
      resource_type: 'AWS::SQS::Queue',
      identifier: 'suc1-b42ee7a8-durable-source.fifo',
      surface: 'tag_index',
      capability_class: 'storage_only',
      ownership_basis: 'recorded_stack',
    } as const;
    const leaked = assess({
      leak_audit: { ...audit, record: { ...audit.record, leak_audit_status: 'leaks_detected', leaks: [leak] } },
    });
    assert.deepEqual(failing(leaked), ['NO_REMAINING_OWNED_RESOURCE']);
    assert.deepEqual(codes(leaked), [`OWNED_RESOURCE_REMAINS:${leak.identifier}`]);
    assert.deepEqual(codes(assess({ leak_audit: undefined })), ['ARTIFACT_MISSING:leak_audit']);
  });

  it('fails CLEAN_SOURCE_AND_MATCHING_QUALIFICATION for an unselected qualification', () => {
    const completion = assess({ selected_qualification: undefined });
    assert.deepEqual(failing(completion), ['CLEAN_SOURCE_AND_MATCHING_QUALIFICATION']);
    assert.deepEqual(codes(completion), ['QUALIFICATION_MISMATCH:qualification']);
  });

  it('lists a reason shared by several checks once', () => {
    const completion = assess({ execution_manifest: undefined, source_provenance: undefined });
    assert.deepEqual(codes(completion), ['ARTIFACT_MISSING:execution_manifest']);
    assert.ok(completion.evidence_refs.every((ref) => ref.artifact_path !== EXECUTION_PATHS.executionManifest));
  });
});
