// The CTR-RUA-004 verifier over golden packages with one thing changed each: eligibility, a
// contradicted summary, safety, late evidence, billing, recovery and its citation, the stored
// results it cites, and hostile summary bytes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonValue, Sha256Hex } from '../../../src/record-contract/primitives.ts';
import type { VariantValidationVerification } from '../../../src/record-contract/records/group-c/variant_validation_verification.ts';
import { compareEvidenceRefs } from '../../../src/record-contract/evidence-refs.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { verifyVariantValidation } from '../../../src/variant-validation/variant-validation-verifier.ts';
import { runExecutionManifest } from '../../contract/record-contract/group-a/support/manifest-examples.ts';
import { FIXTURE_DEPS } from '../../support/evidence-package/probe-package-fixtures.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';
import { RUN_ID, digest, uuid } from '../../support/record-contract/record-builders.ts';
import {
  fileAtPath,
  recordFile,
  replaceFile,
  withoutFile,
} from '../../golden/variant-validation/support/golden-files.ts';
import {
  amendmentChain,
  billingPayload,
  recoveryAmendment,
} from '../../golden/variant-validation/support/validation-amendments.ts';
import type { GoldenAmendment } from '../../golden/variant-validation/support/validation-amendments.ts';
import {
  CLEAN_CLOSURE,
  reindexed,
  validationPackage,
} from '../../golden/variant-validation/support/validation-package.ts';
import {
  CONTROL_TRIAL_ID,
  GOLDEN_VALIDATION_ID,
  goldenAt,
} from '../../golden/variant-validation/support/validation-records.ts';
import { editRecord } from './support/package-edits.ts';
import type { RecordMembers } from './support/package-edits.ts';

const SOUND = validationPackage();

function verify(
  files: readonly PackageFile[],
  amendments: readonly GoldenAmendment[] = [],
  head: Sha256Hex | null = null,
  id = GOLDEN_VALIDATION_ID,
): ReturnType<typeof verifyVariantValidation> {
  return verifyVariantValidation(
    {
      variant_validation_id: id,
      original: { files, special_entries: [] },
      amendments: amendments.map((amendment) => amendment.snapshot),
      selected_head: head,
      referenced_package_indexes: [],
      checked_at: goldenAt(30_000),
    },
    FIXTURE_DEPS,
  );
}

function verified(
  files: readonly PackageFile[],
  amendments: readonly GoldenAmendment[] = [],
): VariantValidationVerification {
  const result = verify(files, amendments, amendments.at(-1)?.index_sha256 ?? null);
  assert.ok(result.ok, JSON.stringify(result));
  const checked = FIXTURE_DEPS.validator.validateAs(
    'variant_validation_verification',
    JSON.parse(JSON.stringify(result.value)) as JsonValue,
  );
  assert.equal(checked.valid, true, JSON.stringify(checked.valid ? [] : checked.violations.slice(0, 3)));
  return result.value;
}

function codes(verification: VariantValidationVerification): readonly string[] {
  return verification.effective_status_reasons.map((reason) => reason.code);
}

// The sound package with its safety assessment edited, re-indexed so the package stays eligible.
function withSafetyEdit(edit: (assessment: RecordMembers) => RecordMembers): readonly PackageFile[] {
  return reindexed(SOUND, editRecord(SOUND.files, EXECUTION_PATHS.safetyAssessment, edit)).files;
}

// The sound package with its summary edited, re-indexed so the package stays eligible.
function withSummaryEdit(
  files: readonly PackageFile[],
  edit: (summary: RecordMembers) => RecordMembers,
): readonly PackageFile[] {
  return reindexed(SOUND, editRecord(files, EXECUTION_PATHS.validationSummary, edit)).files;
}

// The sound package with its late-evidence assessment edited and the summary's reference to it
// re-pinned to the edited bytes, so the package stays eligible and only the assessment changed.
function withLateEdit(
  edit: (assessment: RecordMembers) => RecordMembers,
  summaryEdit: (summary: RecordMembers) => RecordMembers = (summary) => summary,
): readonly PackageFile[] {
  const path = EXECUTION_PATHS.lateEvidenceAssessment;
  const edited = editRecord(SOUND.files, path, edit);
  const ref = { artifact_path: path, artifact_sha256: FIXTURE_DEPS.digest(fileAtPath(edited, path).bytes) };
  return withSummaryEdit(edited, (summary) => summaryEdit({ ...summary, late_evidence_assessment_ref: ref }));
}

function contradictoryLate(assessment: RecordMembers): RecordMembers {
  const [control] = SOUND.summary.trial_results;
  assert.ok('oracle_result_ref' in control);
  return {
    ...assessment,
    late_evidence_status: 'contradictory',
    correlated_record_count: 1,
    reassessments: [
      {
        frozen_result_ref: control.oracle_result_ref,
        trial_id: CONTROL_TRIAL_ID,
        status: 'contradictory',
        changes: [{ field: '/preservation_verdict', frozen: 'pass', reassessed: 'fail' }],
      },
    ],
  };
}

function details(verification: VariantValidationVerification): readonly string[] {
  return verification.effective_status_reasons.map((reason) => reason.detail);
}

describe('verifyVariantValidation', () => {
  it('verifies a sound package and cites the summary and both results by package index', () => {
    const verification = verified(SOUND.files);
    assert.equal(verification.effective_implementation_validation_status, 'verified');
    assert.deepEqual(
      verification.evidence_refs.map((ref) => ref.artifact_path),
      [
        'summary/validation-summary.json',
        ...SOUND.summary.trial_results.map((entry) =>
          'oracle_result_ref' in entry ? entry.oracle_result_ref.artifact_path : '',
        ),
      ].toSorted(),
    );
    assert.ok(verification.evidence_refs.every((ref) => ref.package_index_sha256 === SOUND.index_sha256));
    assert.deepEqual(verification.evidence_refs, verification.evidence_refs.toSorted(compareEvidenceRefs));
  });

  it('is an error without a readable summary, or with the summary of another validation', () => {
    const absent = verify(withoutFile(SOUND.files, EXECUTION_PATHS.validationSummary));
    assert.ok(!absent.ok && absent.error.code === 'SCIENTIFIC_EVIDENCE_MISSING');
    const other = verify(SOUND.files, [], null, uuid(0x1799));
    assert.ok(!other.ok && other.error.code === 'MANIFEST_DRIFT');
  });

  it('is an error, never a throw, for hostile summary bytes (A-05)', () => {
    const depth = 100_000;
    for (const bytes of [
      utf8('['.repeat(depth)),
      utf8(`${'['.repeat(depth)}${']'.repeat(depth)}`),
      Uint8Array.of(0xc3, 0x28),
    ]) {
      assert.equal(verify(replaceFile(SOUND.files, EXECUTION_PATHS.validationSummary, bytes)).ok, false);
    }
  });

  it('makes an ineligible package indeterminate with every effective value unverified', () => {
    const verification = verified([...SOUND.files, { path: 'stray.json', bytes: utf8('{}') }]);
    assert.equal(verification.package_eligibility, 'ineligible');
    assert.equal(verification.effective_implementation_validation_status, 'indeterminate');
    assert.equal(verification.effective_cleanup_status, 'unverified');
    assert.match(verification.effective_status_reasons[0]?.detail ?? '', /ineligible \(UNINDEXED_FILE\)/);
    assert.deepEqual(codes(verification), [
      'PACKAGE_INELIGIBLE',
      'CLEANUP_NOT_SUCCEEDED',
      'LEAK_AUDIT_NOT_CLEAN',
      'LEASE_NOT_RELEASED',
    ]);
  });

  it('judges a manifest of another execution as invalid admission', () => {
    const run = reindexed(
      SOUND,
      replaceFile(SOUND.files, EXECUTION_PATHS.executionManifest, recordFile('x', runExecutionManifest()).bytes),
    );
    const verification = verified(run.files);
    assert.equal(verification.validation_validity, 'invalid');
    assert.ok(codes(verification).includes('ADMISSION_INVALID'));
    assert.ok(codes(verification).includes('DECLARED_STATUS_CONTRADICTED'));
  });

  it('flags a summary whose declared status its own evidence contradicts', () => {
    const verification = verified(
      withSafetyEdit((assessment) => ({
        ...assessment,
        safety_status: 'breached',
        checks: (assessment['checks'] as readonly RecordMembers[]).map((check, position) =>
          position === 0 ? { ...check, result: 'breached' } : check,
        ),
      })),
    );
    assert.equal(verification.declared_implementation_validation_status, 'verified');
    assert.equal(verification.effective_implementation_validation_status, 'indeterminate');
    assert.deepEqual(codes(verification), [
      'DECLARED_STATUS_CONTRADICTED',
      'DECLARED_STATUS_CONTRADICTED',
      'SAFETY_BREACHED',
    ]);
    assert.match(
      verification.effective_status_reasons[0]?.detail ?? '',
      /declares verified \(valid\); its original evidence derives indeterminate \(valid\)/,
    );
    assert.equal(
      verification.effective_status_reasons[1]?.detail,
      'the summary declares safety_status within_limits; its assessment records breached',
    );
  });

  it('does not trust a summary that understates its own evidence', () => {
    const understated = reindexed(
      SOUND,
      editRecord(SOUND.files, EXECUTION_PATHS.validationSummary, (summary) => ({
        ...summary,
        implementation_validation_status: 'indeterminate',
        status_reasons: [{ code: 'LATE_EVIDENCE_UNVERIFIED', subject: 'late_evidence_status', detail: 'claimed' }],
      })),
    );
    const verification = verified(understated.files);
    assert.equal(verification.declared_implementation_validation_status, 'indeterminate');
    assert.equal(verification.effective_implementation_validation_status, 'indeterminate');
    assert.deepEqual(codes(verification), ['DECLARED_STATUS_CONTRADICTED']);
  });

  // Regression of the FC_RUNS=10000 campaign (seed -1827406168, path "8338:8:6:7", counterexample
  // [35,15,1]): a bit flip in the package index's own `created_at` re-seals the package. The index
  // is the trust root, so the verifier cannot tell it from an original; what it must do is pin the
  // verification to the altered index's digest, never to the original one (BR-RUA-035).
  it('pins a re-sealed package index to its own digest, never the original one', () => {
    const indexPosition = SOUND.files.findIndex((file) => file.path === EXECUTION_PATHS.packageIndex);
    const resealed = SOUND.files[indexPosition]?.bytes.slice() ?? new Uint8Array();
    resealed[15] = (resealed[15] ?? 0) ^ 1;
    assert.equal(new TextDecoder().decode(resealed.slice(0, 20)), '{"created_at":"3026-');
    const verification = verified(replaceFile(SOUND.files, EXECUTION_PATHS.packageIndex, resealed));
    assert.equal(verification.effective_implementation_validation_status, 'verified');
    assert.notEqual(verification.original_package_index_sha256, SOUND.index_sha256);
    assert.equal(verification.original_package_index_sha256, FIXTURE_DEPS.digest(resealed));
    assert.ok(
      verification.evidence_refs.every((ref) => ref.package_index_sha256 === FIXTURE_DEPS.digest(resealed)),
      'every reference pins the re-sealed index',
    );
  });

  it('treats an absent, run-scoped, foreign or other-manifest safety assessment as unverified safety', () => {
    const absent = reindexed(SOUND, withoutFile(SOUND.files, EXECUTION_PATHS.safetyAssessment)).files;
    const runScoped = withSafetyEdit(({ variant_validation_id: _id, ...assessment }) => ({
      ...assessment,
      run_id: RUN_ID,
    }));
    const foreign = withSafetyEdit((assessment) => ({ ...assessment, variant_validation_id: uuid(0x1799) }));
    const otherManifest = withSafetyEdit((assessment) => ({
      ...assessment,
      execution_manifest_sha256: digest('another execution manifest'),
    }));
    for (const files of [absent, runScoped, foreign, otherManifest]) {
      const verification = verified(files);
      assert.deepEqual(codes(verification), [
        'DECLARED_STATUS_CONTRADICTED',
        'DECLARED_STATUS_CONTRADICTED',
        'SAFETY_UNVERIFIED',
      ]);
      assert.match(
        details(verification)[1] ?? '',
        /^the summary declares safety_status within_limits; no assessment of this validation backs it \(summary\/safety-assessment\.json (is absent|belongs to validation)/,
      );
      assert.match(
        details(verification)[2] ?? '',
        /^no safety assessment of this validation: summary\/safety-assessment/,
      );
    }
  });

  it('agrees with a summary that declares the unverified safety its missing assessment means', () => {
    const absent = reindexed(SOUND, withoutFile(SOUND.files, EXECUTION_PATHS.safetyAssessment)).files;
    const honest = withSummaryEdit(absent, (summary) => ({
      ...summary,
      safety_status: 'unverified',
      implementation_validation_status: 'indeterminate',
      status_reasons: [{ code: 'SAFETY_UNVERIFIED', subject: 'safety_status', detail: 'no safety assessment' }],
    }));
    const verification = verified(honest);
    assert.equal(verification.effective_implementation_validation_status, 'indeterminate');
    assert.deepEqual(codes(verification), ['SAFETY_UNVERIFIED']);
  });

  it('does not trust a summary whose safety status misstates its own assessment', () => {
    const verification = verified(
      withSummaryEdit(SOUND.files, (summary) => ({ ...summary, safety_status: 'unverified' })),
    );
    assert.equal(verification.declared_implementation_validation_status, 'verified');
    assert.equal(verification.effective_implementation_validation_status, 'indeterminate');
    assert.deepEqual(codes(verification), ['DECLARED_STATUS_CONTRADICTED']);
    assert.deepEqual(details(verification), [
      'the summary declares safety_status unverified; its assessment records within_limits',
    ]);
  });

  it("judges late evidence by this validation's assessment, never by the summary's claim", () => {
    const contradictory = verified(withLateEdit(contradictoryLate));
    assert.equal(contradictory.package_eligibility, 'eligible');
    assert.equal(contradictory.effective_implementation_validation_status, 'indeterminate');
    assert.deepEqual(codes(contradictory), [
      'DECLARED_STATUS_CONTRADICTED',
      'DECLARED_STATUS_CONTRADICTED',
      'LATE_EVIDENCE_CONTRADICTORY',
    ]);
    assert.equal(
      details(contradictory)[1],
      'the summary declares late_evidence_status none; its assessment records contradictory',
    );

    const consistent = withLateEdit(
      (assessment) => ({ ...assessment, late_evidence_status: 'consistent', correlated_record_count: 1 }),
      (summary) => ({ ...summary, late_evidence_status: 'consistent' }),
    );
    const agreed = verified(consistent);
    assert.equal(agreed.effective_implementation_validation_status, 'verified');
    assert.deepEqual(agreed.effective_status_reasons, []);
  });

  it('treats a run-scoped, foreign or other-manifest late-evidence assessment as unverified late evidence', () => {
    const runScoped = withLateEdit(({ variant_validation_id: _id, ...assessment }) => ({
      ...assessment,
      run_id: RUN_ID,
    }));
    const foreign = withLateEdit((assessment) => ({ ...assessment, variant_validation_id: uuid(0x1799) }));
    const otherManifest = withLateEdit((assessment) => ({
      ...assessment,
      execution_manifest_sha256: digest('another execution manifest'),
    }));
    for (const files of [runScoped, foreign, otherManifest]) {
      const verification = verified(files);
      assert.equal(verification.package_eligibility, 'eligible');
      assert.deepEqual(codes(verification), [
        'DECLARED_STATUS_CONTRADICTED',
        'DECLARED_STATUS_CONTRADICTED',
        'LATE_EVIDENCE_UNVERIFIED',
      ]);
      assert.match(
        details(verification)[1] ?? '',
        /^the summary declares late_evidence_status none; no assessment of this validation backs it \(late-evidence\/late-evidence-assessment\.json belongs to validation /,
      );
    }
  });

  // Regression of the single-pass review: a re-sealed summary that names the control's stored
  // result for both trials made the verifier copy that reference twice, and the CTR-RUA-004 record
  // it returned was schema-invalid (duplicate evidence_refs, BR-RUA-035). The verifier cites the
  // stored results it read, each once.
  it('cites each stored oracle result once, never a reference the summary claims', () => {
    const [control, treatment] = SOUND.summary.trial_results;
    assert.ok('oracle_result_ref' in control && 'oracle_result_ref' in treatment);
    const doubled = withSummaryEdit(SOUND.files, (summary) => ({
      ...summary,
      trial_results: [control, { ...treatment, oracle_result_ref: control.oracle_result_ref }],
    }));
    const verification = verified(doubled);
    assert.equal(verification.package_eligibility, 'eligible');
    assert.equal(verification.effective_implementation_validation_status, 'indeterminate');
    assert.deepEqual(codes(verification), ['DECLARED_STATUS_CONTRADICTED', 'CRYPTOGRAPHIC_ANCHOR_MISSING']);
    assert.deepEqual(
      verification.evidence_refs.filter((ref) => ref.artifact_path !== EXECUTION_PATHS.validationSummary),
      [control.oracle_result_ref, treatment.oracle_result_ref]
        .map((ref) => ({ ...ref, package_index_sha256: verification.original_package_index_sha256 }))
        .toSorted(compareEvidenceRefs),
    );
  });

  // The FC_RUNS campaign of the review found the second face of that defect against the old source
  // (seed 986633301, path "11:5:5", counterexample [27,0,1]): with a stored result altered, the
  // verifier cited the summary's digest, which names bytes the package no longer holds.
  it('cites an altered stored result by the digest of the bytes it read', () => {
    const [, treatment] = SOUND.summary.trial_results;
    assert.ok('oracle_result_ref' in treatment);
    const path = treatment.oracle_result_ref.artifact_path;
    const altered = editRecord(SOUND.files, path, (result) => ({ ...result, checked_at: goldenAt(6_001) }));
    const verification = verified(altered);
    assert.equal(verification.package_eligibility, 'ineligible');
    const cited = verification.evidence_refs.find((ref) => ref.artifact_path === path);
    assert.equal(cited?.artifact_sha256, FIXTURE_DEPS.digest(fileAtPath(altered, path).bytes));
    assert.notEqual(cited.artifact_sha256, treatment.oracle_result_ref.artifact_sha256);
  });

  it('cites a stored result once when the manifest declares one trial id for both trials', () => {
    const [control] = SOUND.summary.trial_results;
    assert.ok('oracle_result_ref' in control);
    const repeated = reindexed(
      SOUND,
      editRecord(SOUND.files, EXECUTION_PATHS.executionManifest, (manifest) => {
        const [first, second] = manifest['trials'] as readonly RecordMembers[];
        return { ...manifest, trials: [first, { ...second, trial_id: first?.['trial_id'] }] };
      }),
    );
    const verification = verified(repeated.files);
    assert.equal(verification.validation_validity, 'invalid');
    assert.deepEqual(
      verification.evidence_refs.map((ref) => ref.artifact_path),
      [EXECUTION_PATHS.validationSummary, control.oracle_result_ref.artifact_path],
    );
  });

  it('makes a selected breached billing import a known safety breach', () => {
    const chain = amendmentChain(SOUND, [{ kind: 'BILLING', payload: billingPayload(SOUND, 'breached') }]);
    const verification = verified(SOUND.files, chain);
    assert.equal(verification.declared_implementation_validation_status, 'verified');
    assert.equal(verification.effective_implementation_validation_status, 'indeterminate');
    assert.equal(verification.operational_recovery_applied, false);
    assert.deepEqual(codes(verification), ['SAFETY_BREACHED']);
  });

  it('cites an applied recovery by its amendment index, and nothing for a recovery that changed nothing', () => {
    const partial = validationPackage({ closure: { ...CLEAN_CLOSURE, cleanup_status: 'partial' } });
    const recovery = recoveryAmendment(partial, CLEAN_CLOSURE);
    const repaired = verified(partial.files, [recovery]);
    assert.equal(repaired.operational_recovery_applied, true);
    assert.deepEqual(
      repaired.evidence_refs.filter((ref) => ref.package_index_sha256 === recovery.index_sha256),
      [
        {
          artifact_path: 'amendment-index.json',
          artifact_sha256: recovery.index_sha256,
          package_index_sha256: recovery.index_sha256,
        },
      ],
    );

    const unchanged = recoveryAmendment(SOUND, CLEAN_CLOSURE);
    const same = verified(SOUND.files, [unchanged]);
    assert.equal(same.operational_recovery_applied, false);
    assert.equal(same.effective_implementation_validation_status, 'verified');
    assert.ok(same.evidence_refs.every((ref) => ref.package_index_sha256 === SOUND.index_sha256));
  });

  it('keeps a nonrecoverable terminal reason after recovery repairs the closure', () => {
    const lost = validationPackage({ closure: { ...CLEAN_CLOSURE, cleanup_status: 'partial' } });
    const edited = reindexed(
      lost,
      editRecord(lost.files, EXECUTION_PATHS.validationSummary, (summary) => ({
        ...summary,
        validation_terminal_reason: 'LEASE_LOST',
      })),
    );
    const verification = verified(edited.files, [recoveryAmendment(edited, CLEAN_CLOSURE)]);
    assert.equal(verification.effective_cleanup_status, 'succeeded');
    assert.deepEqual(codes(verification), ['TERMINAL_REASON_NOT_COMPLETED']);
  });
});
