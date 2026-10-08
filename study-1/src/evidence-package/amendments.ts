// Immutable amendments (BR-RUA-043): post-finalization evidence never rewrites a package; it
// creates a new amendment package under `amendments/<execution_id>/<seq:4>-<amendment_id>/` whose
// `amendment-index.json` (written last) hashes every payload file and names the original package
// index and the preceding amendment. Sequence 1 has no parent; sequence n names the index digest
// of amendment n-1, so the chain is linear and digest-valid by construction.
//
// Each kind carries one record that states what the amendment means, which the verifier and the
// effective operational state read back: the late-evidence assessment (LATE_EVIDENCE,
// REASSESSMENT), the operational recovery record (OPERATIONAL_RECOVERY) and the billing import
// (BILLING) (evidence/WP-13/decisions.md).

import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  ExecutionIdentity,
  Result,
  Sha256Hex,
  StructuredReason,
  Uuid4,
  UtcMillis,
} from '../record-contract/primitives.ts';
import type { AmendmentIndex } from '../record-contract/records/group-c/amendment_index.ts';
import type { AmendmentKind } from '../record-contract/records/group-c/vocabulary.ts';
import { classifyAmendmentPayload } from './artifact-classification.ts';
import { buildIndexEntries, coreFileMissing, fileAt } from './index-entries.ts';
import type { PackageFile } from './package-file-system.ts';
import { AMENDMENT_PATHS, PACKAGE_LAYOUT } from './package-layout.ts';

export interface AmendmentInput {
  readonly identity: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly amendment_id: Uuid4;
  readonly amendment_kind: AmendmentKind;
  /** Dense from 1 per execution. */
  readonly sequence: number;
  readonly original_package_index_sha256: Sha256Hex;
  /** `null` exactly for sequence 1. */
  readonly parent_amendment_index_sha256: Sha256Hex | null;
  /** Payload files, at paths relative to the amendment directory (under `payload/`). */
  readonly payload: readonly PackageFile[];
  readonly created_at: UtcMillis;
}

/** A complete amendment package: its directory below the evidence root, its index and every file. */
export interface BuiltAmendment {
  readonly directory: string;
  readonly index: AmendmentIndex;
  /** The payload files followed by `amendment-index.json`, the file to write last. */
  readonly files: readonly PackageFile[];
}

/** The record each amendment kind must carry in its payload. */
export const REQUIRED_PAYLOAD: Readonly<Record<AmendmentKind, string>> = {
  LATE_EVIDENCE: AMENDMENT_PATHS.lateEvidenceAssessment,
  REASSESSMENT: AMENDMENT_PATHS.lateEvidenceAssessment,
  OPERATIONAL_RECOVERY: AMENDMENT_PATHS.operationalRecoveryRecord,
  BILLING: AMENDMENT_PATHS.billingImport,
};

/**
 * Builds an amendment package, or every reason it cannot be built: a sequence that is not a
 * positive safe integer, a parent that contradicts the sequence, a payload path that is invalid,
 * duplicated or foreign to the kind, or the kind's required record missing.
 *
 * @example
 * const built = buildAmendment({ identity, execution_manifest_sha256, amendment_id, amendment_kind: 'BILLING',
 *   sequence: 1, original_package_index_sha256, parent_amendment_index_sha256: null, payload, created_at });
 * if (built.ok) for (const file of built.value.files) await fs.writeOnce(`${built.value.directory}/${file.path}`, file.bytes);
 */
export function buildAmendment(input: AmendmentInput): Result<BuiltAmendment, readonly StructuredReason[]> {
  const entries = buildIndexEntries(input.payload, (path) => classifyAmendmentPayload(path, input.amendment_kind));
  const required = REQUIRED_PAYLOAD[input.amendment_kind];
  const reasons = [
    ...sequenceReasons(input.sequence, input.parent_amendment_index_sha256),
    ...(fileAt(input.payload, required) === undefined ? [coreFileMissing(required)] : []),
    ...(entries.ok ? [] : entries.error),
  ];
  if (!entries.ok || reasons.length > 0) {
    return err(reasons);
  }
  const index: AmendmentIndex = {
    schema_version: 1,
    record_type: 'amendment_index',
    ...executionIdentityFields(input.identity),
    execution_manifest_sha256: input.execution_manifest_sha256,
    amendment_id: input.amendment_id,
    amendment_kind: input.amendment_kind,
    sequence: input.sequence,
    original_package_index_sha256: input.original_package_index_sha256,
    parent_amendment_index_sha256: input.parent_amendment_index_sha256,
    entries: entries.value,
    created_at: input.created_at,
  };
  return ok({
    directory: PACKAGE_LAYOUT.amendmentDirectory(input.identity, input.sequence, input.amendment_id),
    index,
    files: [...input.payload, { path: AMENDMENT_PATHS.amendmentIndex, bytes: serializeRecordFile(index) }],
  });
}

function sequenceReasons(sequence: number, parent: Sha256Hex | null): readonly StructuredReason[] {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    return [
      amendmentReason('INVALID_SEQUENCE', `sequence ${boundedJsonText(sequence)}; expected a positive safe integer`),
    ];
  }
  if ((sequence === 1) === (parent === null)) {
    return [];
  }
  const expected = sequence === 1 ? 'null for sequence 1' : `the index digest of amendment ${String(sequence - 1)}`;
  return [
    amendmentReason(
      'PARENT_MISMATCH',
      `sequence ${String(sequence)} has parent ${parent ?? 'null'}; expected ${expected}`,
    ),
  ];
}

function amendmentReason(code: string, detail: string): StructuredReason {
  return { code, subject: 'BR-RUA-043', detail };
}
