// The CTR-RUA-004 verifier over golden packages with one thing changed each: eligibility, a
// contradicted summary, safety, billing, recovery and its citation, and hostile summary bytes.

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
import { RUN_ID, uuid } from '../../support/record-contract/record-builders.ts';
import { recordFile, replaceFile, withoutFile } from '../../golden/variant-validation/support/golden-files.ts';
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
import { GOLDEN_VALIDATION_ID, goldenAt } from '../../golden/variant-validation/support/validation-records.ts';
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
    assert.deepEqual(codes(verification), ['DECLARED_STATUS_CONTRADICTED', 'SAFETY_BREACHED']);
    assert.match(
      verification.effective_status_reasons[0]?.detail ?? '',
      /declares verified \(valid\); its original evidence derives indeterminate \(valid\)/,
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

  it('treats an absent, run-scoped or foreign safety assessment as unverified safety', () => {
    const absent = reindexed(SOUND, withoutFile(SOUND.files, EXECUTION_PATHS.safetyAssessment)).files;
    const runScoped = withSafetyEdit(({ variant_validation_id: _id, ...assessment }) => ({
      ...assessment,
      run_id: RUN_ID,
    }));
    const foreign = withSafetyEdit((assessment) => ({ ...assessment, variant_validation_id: uuid(0x1799) }));
    for (const files of [absent, runScoped, foreign]) {
      assert.deepEqual(codes(verified(files)), ['DECLARED_STATUS_CONTRADICTED', 'SAFETY_UNVERIFIED']);
    }
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
