// Reading the records a variant-validation verifier needs back from the exact stored bytes of a
// package (BR-RUA-033). Total over arbitrary bytes (A-05): the kernel's strict UTF-8 and JSON
// parser, then the catalogue validator; any failure is a bounded problem text, never a throw.
// The caller turns the problem into the reason its condition names (missing scientific evidence,
// invalid admission, a missing anchor, unverified safety), because the same unreadable file means
// a different thing for each.

import { boundedJsonText, boundedText } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, Uuid4 } from '../record-contract/primitives.ts';
import type { ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { SourceProvenance } from '../record-contract/records/group-a/source_provenance.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { BillingImport } from '../record-contract/records/group-c/billing_import.ts';
import type { EvidenceIndex } from '../record-contract/records/group-c/evidence_index.ts';
import type { LateEvidenceAssessment } from '../record-contract/records/group-c/late_evidence_assessment.ts';
import type { OracleResult } from '../record-contract/records/group-c/oracle_result.ts';
import type { OracleRevisionCheck } from '../record-contract/records/group-c/oracle_revision_check.ts';
import type { SafetyAssessment } from '../record-contract/records/group-c/safety_assessment.ts';
import type { ValidationSummary } from '../record-contract/records/group-c/validation_summary.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { fileAt } from '../evidence-package/index-entries.ts';

/** The record types the verifier reads back, by `record_type`. */
export interface ValidationRecordByType {
  readonly execution_manifest: ExecutionManifest;
  readonly source_provenance: SourceProvenance;
  readonly oracle_revision_check: OracleRevisionCheck;
  readonly trial_manifest: TrialManifest;
  readonly oracle_result: OracleResult;
  readonly evidence_index: EvidenceIndex;
  readonly safety_assessment: SafetyAssessment;
  readonly late_evidence_assessment: LateEvidenceAssessment;
  readonly validation_summary: ValidationSummary;
  readonly billing_import: BillingImport;
}

export type ValidationRecordType = keyof ValidationRecordByType;

/** A record read back, with the exact stored bytes its digests are taken over. */
export interface StoredRecord<T> {
  readonly record: T;
  readonly bytes: Uint8Array;
}

/**
 * The record of `recordType` stored at `path` in `files`, or why it cannot be read: the problem
 * names the path, what failed (absent, not UTF-8 JSON, the first schema violation and how many
 * there are) and the expected record type.
 *
 * @example
 * const manifest = readValidationRecord(files, 'admission/execution-manifest.json', 'execution_manifest', validator);
 * if (!manifest.ok) reasons.push(validationReason('ADMISSION_INVALID', 'admission', manifest.error));
 * else manifest.value.record.execution_kind; // 'VARIANT_VALIDATION' for a validation package
 */
export function readValidationRecord<K extends ValidationRecordType>(
  files: readonly PackageFile[],
  path: string,
  recordType: K,
  validator: RecordValidator,
): Result<StoredRecord<ValidationRecordByType[K]>, string> {
  const file = fileAt(files, path);
  if (file === undefined) {
    return err(`${path} is absent; expected a ${recordType} record`);
  }
  const parsed = parseJsonDocument(file.bytes);
  if (!parsed.ok) {
    const failure =
      parsed.error.kind === 'invalid_utf8'
        ? `invalid UTF-8 at byte ${String(parsed.error.byte_offset)}`
        : boundedText(parsed.error.detail);
    return err(`${path} is not one JSON document (${failure}); expected a ${recordType} record`);
  }
  const checked = validator.validateAs(recordType, parsed.value);
  if (!checked.valid) {
    const shown = checked.violations
      .slice(0, 1)
      .map((violation) => `, first ${violation.keyword} at ${boundedJsonText(violation.instance_path)}`)
      .join('');
    return err(
      `${path} has ${String(checked.violations.length)} schema violation(s)${shown}; expected a valid ${recordType} record`,
    );
  }
  // validateAs checked the document against the schema of `recordType`, so it is that record type.
  const record = checked.record as unknown as ValidationRecordByType[K];
  return ok({ record, bytes: file.bytes });
}

/** The execution an execution-level record must belong to: this validation, under this manifest. */
export interface ValidationRecordOwner {
  readonly variant_validation_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
}

/** The execution-level assessments a validation package holds once, outside its trials. */
export type OwnedValidationRecordType = 'safety_assessment' | 'late_evidence_assessment';

/**
 * The execution-level record of `recordType` at `path`, read as `readValidationRecord` reads it,
 * when it belongs to `owner`; an assessment of another execution or manifest says nothing about
 * this validation, so it is a problem that names both identities, never a record.
 *
 * @example
 * const late = readOwnValidationRecord(files, 'late-evidence/late-evidence-assessment.json',
 *   'late_evidence_assessment', { variant_validation_id, execution_manifest_sha256 }, validator);
 * late.ok ? late.value.late_evidence_status : 'unverified';
 */
export function readOwnValidationRecord<K extends OwnedValidationRecordType>(
  files: readonly PackageFile[],
  path: string,
  recordType: K,
  owner: ValidationRecordOwner,
  validator: RecordValidator,
): Result<ValidationRecordByType[K], string> {
  const read = readValidationRecord(files, path, recordType, validator);
  if (!read.ok) {
    return err(read.error);
  }
  const { record } = read.value;
  const validationId = 'variant_validation_id' in record ? record.variant_validation_id : undefined;
  if (
    validationId === owner.variant_validation_id &&
    record.execution_manifest_sha256 === owner.execution_manifest_sha256
  ) {
    return ok(record);
  }
  return err(
    `${path} belongs to validation ${validationId ?? 'none (another execution kind)'} under manifest ${record.execution_manifest_sha256}; expected validation ${owner.variant_validation_id} under manifest ${owner.execution_manifest_sha256}`,
  );
}
