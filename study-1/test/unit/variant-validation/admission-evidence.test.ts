// Admission evidence as the verifier reads it back (BR-RUA-040, BR-RUA-042, D-18): this
// validation's manifest, the provenance it froze by digest on the same commit and tree, and a passed
// oracle revision check of that commit and tree.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { readAdmissionEvidence } from '../../../src/variant-validation/admission-evidence.ts';
import { runExecutionManifest } from '../../contract/record-contract/group-a/support/manifest-examples.ts';
import { FIXTURE_DEPS } from '../../support/evidence-package/probe-package-fixtures.ts';
import { uuid } from '../../support/record-contract/record-builders.ts';
import { recordFile, replaceFile, withoutFile } from '../../golden/variant-validation/support/golden-files.ts';
import { validationPackage } from '../../golden/variant-validation/support/validation-package.ts';
import {
  GOLDEN_VALIDATION_ID,
  goldenRevisionCheck,
} from '../../golden/variant-validation/support/validation-records.ts';
import { editRecord } from './support/package-edits.ts';

const FILES = validationPackage().files;

function defectDetails(files: readonly PackageFile[]): readonly string[] {
  const admission = readAdmissionEvidence(files, GOLDEN_VALIDATION_ID, FIXTURE_DEPS);
  assert.ok(admission.ok);
  assert.ok(admission.value.defects.every((reason) => reason.code === 'ADMISSION_INVALID'));
  return admission.value.defects.map((reason) => reason.detail);
}

function manifestError(files: readonly PackageFile[], id = GOLDEN_VALIDATION_ID): string {
  const admission = readAdmissionEvidence(files, id, FIXTURE_DEPS);
  assert.equal(admission.ok, false);
  assert.equal(admission.error.code, 'ADMISSION_INVALID');
  assert.equal(admission.error.artifact_path, EXECUTION_PATHS.executionManifest);
  return admission.error.detail;
}

describe('readAdmissionEvidence', () => {
  it('reads a sound admission: the manifest, the digest of its stored bytes and no defect', () => {
    const admission = readAdmissionEvidence(FILES, GOLDEN_VALIDATION_ID, FIXTURE_DEPS);
    assert.ok(admission.ok);
    const stored = FILES.find((file) => file.path === EXECUTION_PATHS.executionManifest);
    assert.equal(admission.value.execution_manifest_sha256, sha256Hex(stored?.bytes ?? new Uint8Array()));
    assert.equal(admission.value.manifest.variant_validation_id, GOLDEN_VALIDATION_ID);
    assert.deepEqual(admission.value.defects, []);
  });

  it('is an error without a readable manifest', () => {
    assert.match(manifestError(withoutFile(FILES, EXECUTION_PATHS.executionManifest)), /is absent/);
  });

  it('is an error for a manifest of another execution kind or another validation', () => {
    const run = replaceFile(FILES, EXECUTION_PATHS.executionManifest, recordFile('x', runExecutionManifest()).bytes);
    assert.match(manifestError(run), /freezes a RUN execution of another id/);
    assert.match(manifestError(FILES, uuid(0x1799)), /freezes a VARIANT_VALIDATION execution of another id/);
  });

  it('reports an absent source provenance', () => {
    assert.deepEqual(
      defectDetails(withoutFile(FILES, EXECUTION_PATHS.sourceProvenance)).map((detail) => detail.split(';')[0]),
      [`${EXECUTION_PATHS.sourceProvenance} is absent`],
    );
  });

  it('reports a provenance whose bytes are not the ones the manifest froze', () => {
    const edited = editRecord(FILES, EXECUTION_PATHS.sourceProvenance, (record) => ({ ...record, branch: 'other' }));
    const [detail, ...rest] = defectDetails(edited);
    assert.match(detail ?? '', /hashes to [0-9a-f]{64}; expected the source_provenance_sha256/);
    assert.deepEqual(rest, []);
  });

  it('reports a provenance of another commit or tree', () => {
    const edited = editRecord(FILES, EXECUTION_PATHS.sourceProvenance, (record) => ({
      ...record,
      tree_sha: 'f'.repeat(40),
    }));
    const details = defectDetails(edited);
    assert.equal(details.length, 2);
    assert.match(details[1] ?? '', new RegExp(`tree ${'f'.repeat(40)}; expected the manifest's commit`));
  });

  it('reports an absent, failed or mismatched oracle revision check', () => {
    assert.equal(defectDetails(withoutFile(FILES, EXECUTION_PATHS.oracleRevisionCheck)).length, 1);
    const failed = replaceFile(
      FILES,
      EXECUTION_PATHS.oracleRevisionCheck,
      recordFile('x', goldenRevisionCheck('failed')).bytes,
    );
    assert.match(defectDetails(failed)[0] ?? '', /has result failed; expected passed \(D-18\)/);
    const otherCommit = editRecord(FILES, EXECUTION_PATHS.oracleRevisionCheck, (record) => ({
      ...record,
      commit_sha: 'a'.repeat(40),
    }));
    assert.match(defectDetails(otherCommit)[0] ?? '', new RegExp(`names commit ${'a'.repeat(40)}`));
  });
});
