// Reading the frozen records the comparison, the summary and the completion verifier consume
// (design §8.14 "computed from the frozen manifests"). Package bytes are untrusted input (A-05):
// every read goes through the kernel's strict UTF-8 and JSON parser and the catalogue validator,
// and a defect becomes a reason, never a throw. A record is kept with a reference to the exact
// bytes it came from, so every result can cite what it read (BR-RUA-035).

import { boundedJsonText, boundedText, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument, parseJsonl } from '../record-contract/parsing.ts';
import type { JsonParseFailure } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonValue, Result, StructuredReason } from '../record-contract/primitives.ts';
import type { ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { ProviderTrialConfiguration } from '../record-contract/records/group-a/provider_trial_configuration.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type { SourceProvenance } from '../record-contract/records/group-a/source_provenance.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { LeaseEventRecorded } from '../record-contract/records/group-b/lease_event_recorded.ts';
import type { PhaseTransitionRecorded } from '../record-contract/records/group-b/phase_transition_recorded.ts';
import type { TrialInterrupted } from '../record-contract/records/group-b/trial_interrupted.ts';
import type { CleanupResult } from '../record-contract/records/group-c/cleanup_result.ts';
import type { ComparisonAssessment } from '../record-contract/records/group-c/comparison_assessment.ts';
import type { LateEvidenceAssessment } from '../record-contract/records/group-c/late_evidence_assessment.ts';
import type { LeakAuditResult } from '../record-contract/records/group-c/leak_audit_result.ts';
import type { OracleResult } from '../record-contract/records/group-c/oracle_result.ts';
import type { RunSummary } from '../record-contract/records/group-c/run_summary.ts';
import type { SafetyAssessment } from '../record-contract/records/group-c/safety_assessment.ts';
import type { ArtifactRef } from '../record-contract/records/group-c/shared-shapes.ts';
import type { RecordValidator, SchemaViolation } from '../record-contract/schema-registry.ts';
import type { ByteDigest } from '../evidence-package/package-integrity.ts';
import { comparisonReason } from './comparison-reasons.ts';

/** Package-relative path to the exact stored bytes. */
export type PackageFiles = ReadonlyMap<string, Uint8Array>;

/** A record read back from a package, with the reference to the bytes it came from. */
export interface FrozenRecord<T> {
  readonly record: T;
  readonly ref: ArtifactRef;
}

/** The record types this feature reads, by catalogue name. */
export interface StudyComparisonRecords {
  readonly execution_manifest: ExecutionManifest;
  readonly resource_manifest: ResourceManifest;
  readonly trial_manifest: TrialManifest;
  readonly provider_trial_configuration: ProviderTrialConfiguration;
  readonly source_provenance: SourceProvenance;
  readonly oracle_result: OracleResult;
  readonly late_evidence_assessment: LateEvidenceAssessment;
  readonly cleanup_result: CleanupResult;
  readonly leak_audit_result: LeakAuditResult;
  readonly safety_assessment: SafetyAssessment;
  readonly comparison_assessment: ComparisonAssessment;
  readonly run_summary: RunSummary;
  readonly phase_transition_recorded: PhaseTransitionRecorded;
  readonly trial_interrupted: TrialInterrupted;
  readonly lease_event_recorded: LeaseEventRecorded;
}
export type StudyComparisonRecordType = keyof StudyComparisonRecords;

/** One record file: not stored, stored but not a valid record of its type, or read. */
export type RecordFileRead<T> =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly reason: StructuredReason }
  | { readonly status: 'read'; readonly frozen: FrozenRecord<T> };

/** The records of one journal that have the requested types, and every line that could not be read. */
export interface JournalRead<T> {
  readonly records: readonly T[];
  readonly reasons: readonly StructuredReason[];
}

/** The services record reading uses: the catalogue validator and the byte digest (production: `sha256Hex`). */
export interface RecordReadingDeps {
  readonly validator: RecordValidator;
  readonly digest: ByteDigest;
}

/**
 * Reads one JSON record file of a known type; total over arbitrary bytes.
 *
 * @example
 * const read = readRecordFile(files, 'cleanup/cleanup-result.json', 'cleanup_result', deps);
 * if (read.status === 'read') read.frozen.record.cleanup_status;
 */
export function readRecordFile<K extends StudyComparisonRecordType>(
  files: PackageFiles,
  path: string,
  recordType: K,
  deps: RecordReadingDeps,
): RecordFileRead<StudyComparisonRecords[K]> {
  const bytes = files.get(path);
  if (bytes === undefined) {
    return { status: 'absent' };
  }
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok) {
    return {
      status: 'unreadable',
      reason: unreadable(path, `${parseFailureText(parsed.error)}; expected one UTF-8 JSON ${recordType} document`),
    };
  }
  const checked = checkRecord(parsed.value, recordType, deps.validator);
  if (!checked.ok) {
    return { status: 'unreadable', reason: unreadable(path, checked.error) };
  }
  return {
    status: 'read',
    frozen: { record: checked.value, ref: { artifact_path: path, artifact_sha256: deps.digest(bytes) } },
  };
}

/**
 * The reference to a stored file's exact bytes, or undefined when it is not stored: the payment and
 * approved-decision inputs are compared by digest only (design §8.14 `financial_inputs`).
 *
 * @example
 * bytesRef(files, 'trials/<id>/inputs/payment.json', sha256Hex); // { artifact_path, artifact_sha256 }
 */
export function bytesRef(files: PackageFiles, path: string, digest: ByteDigest): ArtifactRef | undefined {
  const bytes = files.get(path);
  return bytes === undefined ? undefined : { artifact_path: path, artifact_sha256: digest(bytes) };
}

/**
 * Reads the lines of a JSONL journal whose `record_type` is one of `recordTypes`, in file order.
 * Lines of other types are skipped unread; a line that is not JSON, or a line of a requested type
 * that is not a valid record of it, is reported and left out. An absent journal reads as empty.
 *
 * @example
 * const runner = readJournalRecords(files, 'runner/runner-journal.jsonl', ['phase_transition_recorded'], deps);
 */
export function readJournalRecords<K extends StudyComparisonRecordType>(
  files: PackageFiles,
  path: string,
  recordTypes: readonly K[],
  deps: RecordReadingDeps,
): JournalRead<StudyComparisonRecords[K]> {
  const bytes = files.get(path);
  if (bytes === undefined) {
    return { records: [], reasons: [] };
  }
  const records: StudyComparisonRecords[K][] = [];
  const reasons: StructuredReason[] = [];
  for (const line of parseJsonl(bytes).lines) {
    const at = `${path} line ${String(line.line_number)}`;
    if (!line.parsed.ok) {
      reasons.push(
        unreadable(path, `${at}: ${parseFailureText(line.parsed.error)}; expected one JSON record per line`),
      );
      continue;
    }
    const recordType = requestedType(line.parsed.value, recordTypes);
    const checked = recordType === undefined ? undefined : checkRecord(line.parsed.value, recordType, deps.validator);
    if (checked?.ok === false) {
      reasons.push(unreadable(path, `${at}: ${checked.error}`));
    } else if (checked !== undefined) {
      records.push(checked.value);
    }
  }
  return { records, reasons };
}

// The requested record type a line declares, read from an own member only (A-05).
function requestedType<K extends string>(value: JsonValue, recordTypes: readonly K[]): K | undefined {
  if (!isJsonObject(value) || !Object.hasOwn(value, 'record_type')) {
    return undefined;
  }
  const declared = value['record_type'];
  return recordTypes.find((recordType) => recordType === declared);
}

// The typed record, or the text of what made it invalid.
function checkRecord<K extends StudyComparisonRecordType>(
  value: JsonValue,
  recordType: K,
  validator: RecordValidator,
): Result<StudyComparisonRecords[K], string> {
  const checked = validator.validateAs(recordType, value);
  if (!checked.valid) {
    return err(`${describeViolations(checked.violations)}; expected a valid ${recordType}`);
  }
  // validateAs checked the value against the schema of `recordType`, so it is that record type.
  return ok(checked.record as unknown as StudyComparisonRecords[K]);
}

function parseFailureText(failure: JsonParseFailure): string {
  return failure.kind === 'invalid_utf8'
    ? `invalid UTF-8 at byte ${String(failure.byte_offset)}`
    : boundedText(failure.detail);
}

// The count and the first violation, bounded: Ajv builds the instance path from untrusted member
// names, so it is quoted through the kernel's bounded renderer (A-05).
function describeViolations(violations: readonly SchemaViolation[]): string {
  const firstText = violations
    .slice(0, 1)
    .map((first) => `, first ${first.keyword} at ${boundedJsonText(first.instance_path)}: ${boundedText(first.detail)}`)
    .join('');
  return `${String(violations.length)} schema violation(s)${firstText}`;
}

function unreadable(path: string, detail: string): StructuredReason {
  return comparisonReason('ARTIFACT_UNREADABLE', 'BR-RUA-033', `${path}: ${detail}`, path);
}
