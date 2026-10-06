// The admission evidence of a variant validation as the verifier reads it back (BR-RUA-040,
// BR-RUA-042, D-18; design §8.15). A validation is scientifically admissible only when its frozen
// execution manifest is this validation's `VARIANT_VALIDATION` manifest, its source provenance is
// the one the manifest froze by digest and names the same commit and tree, and the oracle revision
// check that admitted it passed on that same commit and tree. Any other admission is invalid
// admission, which operational recovery can never repair (AC-RUA-037).

import type { Sha256Hex, Uuid4 } from '../record-contract/primitives.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result } from '../record-contract/primitives.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import type { ByteDigest } from '../evidence-package/package-integrity.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { readValidationRecord } from './validation-records.ts';
import { validationReason } from './validation-reasons.ts';
import type { ValidationReason } from './validation-reasons.ts';
import type { ValidationManifest } from './validation-summary.ts';

/** The admitted manifest, the digest of its stored bytes, and every admission defect found. */
export interface AdmissionEvidence {
  readonly manifest: ValidationManifest;
  readonly execution_manifest_sha256: Sha256Hex;
  /** `ADMISSION_INVALID` reasons for the provenance and the oracle revision check; empty when sound. */
  readonly defects: readonly ValidationReason[];
}

/** The services admission reading uses. */
export interface AdmissionReadDeps {
  readonly validator: RecordValidator;
  readonly digest: ByteDigest;
}

/**
 * Reads the admission evidence of `variantValidationId` from a package's files. Without a readable
 * manifest of this validation there are no declared trials to judge, so that case is an error.
 *
 * @example
 * const admission = readAdmissionEvidence(files, variantValidationId, { validator, digest: sha256Hex });
 * if (admission.ok) admission.value.defects; // [] for a sound admission
 */
export function readAdmissionEvidence(
  files: readonly PackageFile[],
  variantValidationId: Uuid4,
  deps: AdmissionReadDeps,
): Result<AdmissionEvidence, ValidationReason> {
  const path = EXECUTION_PATHS.executionManifest;
  const read = readValidationRecord(files, path, 'execution_manifest', deps.validator);
  if (!read.ok) {
    return err(admissionInvalid(read.error, path));
  }
  const manifest = read.value.record;
  if (manifest.execution_kind !== 'VARIANT_VALIDATION' || manifest.variant_validation_id !== variantValidationId) {
    return err(
      admissionInvalid(
        `${path} freezes a ${manifest.execution_kind} execution of another id; expected the VARIANT_VALIDATION manifest of ${variantValidationId}`,
        path,
      ),
    );
  }
  return ok({
    manifest,
    execution_manifest_sha256: deps.digest(read.value.bytes),
    defects: [...provenanceDefects(files, manifest, deps), ...revisionCheckDefects(files, manifest, deps.validator)],
  });
}

function provenanceDefects(
  files: readonly PackageFile[],
  manifest: ValidationManifest,
  deps: AdmissionReadDeps,
): readonly ValidationReason[] {
  const path = EXECUTION_PATHS.sourceProvenance;
  const read = readValidationRecord(files, path, 'source_provenance', deps.validator);
  if (!read.ok) {
    return [admissionInvalid(read.error, path)];
  }
  const stored = deps.digest(read.value.bytes);
  const { source } = manifest;
  return [
    ...(stored === source.source_provenance_sha256
      ? []
      : [
          admissionInvalid(
            `${path} hashes to ${stored}; expected the source_provenance_sha256 ${source.source_provenance_sha256} the manifest froze`,
            path,
          ),
        ]),
    ...revisionMismatch(path, read.value.record, source),
  ];
}

function revisionCheckDefects(
  files: readonly PackageFile[],
  manifest: ValidationManifest,
  validator: RecordValidator,
): readonly ValidationReason[] {
  const path = EXECUTION_PATHS.oracleRevisionCheck;
  const read = readValidationRecord(files, path, 'oracle_revision_check', validator);
  if (!read.ok) {
    return [admissionInvalid(read.error, path)];
  }
  const check = read.value.record;
  return [
    ...(check.result === 'passed'
      ? []
      : [admissionInvalid(`${path} has result ${check.result}; expected passed (D-18)`, path)]),
    ...revisionMismatch(path, check, manifest.source),
  ];
}

function revisionMismatch(
  path: string,
  observed: { readonly commit_sha: string; readonly tree_sha: string },
  declared: { readonly commit_sha: string; readonly tree_sha: string },
): readonly ValidationReason[] {
  if (observed.commit_sha === declared.commit_sha && observed.tree_sha === declared.tree_sha) {
    return [];
  }
  return [
    admissionInvalid(
      `${path} names commit ${observed.commit_sha} tree ${observed.tree_sha}; expected the manifest's commit ${declared.commit_sha} tree ${declared.tree_sha}`,
      path,
    ),
  ];
}

function admissionInvalid(detail: string, path: string): ValidationReason {
  return validationReason('ADMISSION_INVALID', 'admission', detail, path);
}
