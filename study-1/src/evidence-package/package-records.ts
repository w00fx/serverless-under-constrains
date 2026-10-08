// Parsing of the package records the verifier and the amendment code read back from exact bytes
// (BR-RUA-033). Every call is total over arbitrary bytes (AC-RUA-046 fuzz: "the JSON, JSONL and
// package parsers never crash on malformed input"): it goes through the kernel's strict UTF-8 and
// JSON parser and the catalogue validator, and reports a reason instead of throwing.

import { boundedJsonText, boundedText } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { DeploymentAssemblyInventory } from '../record-contract/records/group-a/deployment_assembly_inventory.ts';
import type { CoordinationPrefixCheckpoint } from '../record-contract/records/group-b/coordination_prefix_checkpoint.ts';
import type { AmendmentIndex } from '../record-contract/records/group-c/amendment_index.ts';
import type { EvidenceIndex } from '../record-contract/records/group-c/evidence_index.ts';
import type { LateEvidenceAssessment } from '../record-contract/records/group-c/late_evidence_assessment.ts';
import type { OperationalRecoveryRecord } from '../record-contract/records/group-c/operational_recovery_record.ts';
import type { PackageIndex } from '../record-contract/records/group-c/package_index.ts';
import type { RunSummary } from '../record-contract/records/group-c/run_summary.ts';
import type { TransportProbeSummary } from '../record-contract/records/group-c/transport_probe_summary.ts';
import type { ValidationSummary } from '../record-contract/records/group-c/validation_summary.ts';
import type { RecordValidator, SchemaViolation } from '../record-contract/schema-registry.ts';

/** The record types this feature reads back from package bytes. */
export interface PackageRecordByType {
  readonly package_index: PackageIndex;
  readonly evidence_index: EvidenceIndex;
  readonly amendment_index: AmendmentIndex;
  readonly deployment_assembly_inventory: DeploymentAssemblyInventory;
  readonly coordination_prefix_checkpoint: CoordinationPrefixCheckpoint;
  readonly late_evidence_assessment: LateEvidenceAssessment;
  readonly operational_recovery_record: OperationalRecoveryRecord;
  readonly run_summary: RunSummary;
  readonly validation_summary: ValidationSummary;
  readonly transport_probe_summary: TransportProbeSummary;
}

export type PackageRecordType = keyof PackageRecordByType;

/** The most schema violations one reason quotes; the rest are counted. */
const QUOTED_VIOLATIONS = 3;

/**
 * Parses one record file and validates it against its catalogue schema. The reason names the
 * file, the record type and what failed: `RECORD_UNPARSEABLE` for bytes that are not one UTF-8
 * JSON document, `RECORD_SCHEMA_INVALID` for a document that is not a valid record of the type.
 *
 * @example
 * const index = parsePackageRecord(bytes, 'package_index', validator, 'package-index.json');
 * if (!index.ok) reasons.push(index.error);
 */
export function parsePackageRecord<K extends PackageRecordType>(
  bytes: Uint8Array,
  recordType: K,
  validator: RecordValidator,
  path: string,
): Result<PackageRecordByType[K], StructuredReason> {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok) {
    const failure =
      parsed.error.kind === 'invalid_utf8'
        ? `invalid UTF-8 at byte ${String(parsed.error.byte_offset)}`
        : boundedText(parsed.error.detail);
    return err(recordReason('RECORD_UNPARSEABLE', path, `${failure}; expected one UTF-8 JSON ${recordType} document`));
  }
  const checked = validator.validateAs(recordType, parsed.value);
  if (!checked.valid) {
    return err(
      recordReason(
        'RECORD_SCHEMA_INVALID',
        path,
        `${describeViolations(checked.violations)}; expected a valid ${recordType}`,
      ),
    );
  }
  // validateAs checked the document against the schema of `recordType`, so it is that record type.
  return ok(checked.record as unknown as PackageRecordByType[K]);
}

function describeViolations(violations: readonly SchemaViolation[]): string {
  const quoted = violations
    .slice(0, QUOTED_VIOLATIONS)
    .map((violation) => `${violation.keyword} at ${boundedJsonText(violation.instance_path)}: ${violation.detail}`);
  const more = violations.length - quoted.length;
  return `${String(violations.length)} schema violation(s): ${quoted.join('; ')}${more > 0 ? ` and ${String(more)} more` : ''}`;
}

function recordReason(code: string, path: string, detail: string): StructuredReason {
  return { code, subject: 'BR-RUA-033', artifact_path: path, detail: `${path}: ${detail}` };
}
