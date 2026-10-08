// Reading the records probe usability needs back from the exact stored bytes of a probe package or
// of one of its amendments (BR-RUA-033). Total over arbitrary bytes (A-05): the kernel's strict
// UTF-8 and JSON parser, then the catalogue validator; an absent, unparseable or schema-invalid
// file is `undefined`, never a throw. Usability turns that absence into the row it fails.

import type { AmendmentSnapshot } from '../../evidence-package/amendment-snapshots.ts';
import { fileAt } from '../../evidence-package/index-entries.ts';
import type { ByteDigest } from '../../evidence-package/package-integrity.ts';
import type { PackageFile } from '../../evidence-package/package-file-system.ts';
import { AMENDMENT_PATHS } from '../../evidence-package/package-layout.ts';
import { parseJsonDocument } from '../../record-contract/parsing.ts';
import type { Sha256Hex } from '../../record-contract/primitives.ts';
import type { TransportScopeSnapshot } from '../../record-contract/records/group-a/transport_scope_snapshot.ts';
import type { BillingImport } from '../../record-contract/records/group-c/billing_import.ts';
import type { LateEvidenceAssessment } from '../../record-contract/records/group-c/late_evidence_assessment.ts';
import type { PackageIndex } from '../../record-contract/records/group-c/package_index.ts';
import type { TransportProbeResult } from '../../record-contract/records/group-c/transport_probe_result.ts';
import type { TransportProbeSummary } from '../../record-contract/records/group-c/transport_probe_summary.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';

/** The record types probe usability reads back, by `record_type`. */
export interface ProbeRecordByType {
  readonly package_index: PackageIndex;
  readonly transport_probe_summary: TransportProbeSummary;
  readonly transport_probe_result: TransportProbeResult;
  readonly transport_scope_snapshot: TransportScopeSnapshot;
  readonly late_evidence_assessment: LateEvidenceAssessment;
  readonly billing_import: BillingImport;
}

export type ProbeRecordType = keyof ProbeRecordByType;

/** A record read back, with the digest of its exact stored bytes. */
export interface StoredProbeRecord<T> {
  readonly record: T;
  readonly sha256: Sha256Hex;
}

/** The services record reading uses: the catalogue validator and the byte digest. */
export interface ProbeRecordDeps {
  readonly validator: RecordValidator;
  readonly digest: ByteDigest;
}

/**
 * The record of `recordType` stored at `path`, or `undefined` when it is absent or unreadable.
 *
 * @example
 * readProbeRecord(files, 'summary/transport-probe-summary.json', 'transport_probe_summary', deps)?.record.cleanup_status;
 */
export function readProbeRecord<K extends ProbeRecordType>(
  files: readonly PackageFile[],
  path: string,
  recordType: K,
  deps: ProbeRecordDeps,
): StoredProbeRecord<ProbeRecordByType[K]> | undefined {
  const file = fileAt(files, path);
  const parsed = file === undefined ? undefined : parseJsonDocument(file.bytes);
  if (file === undefined || parsed?.ok !== true) {
    return undefined;
  }
  const checked = deps.validator.validateAs(recordType, parsed.value);
  // validateAs checked the document against the schema of `recordType`, so it is that record type.
  return checked.valid
    ? { record: checked.record as unknown as ProbeRecordByType[K], sha256: deps.digest(file.bytes) }
    : undefined;
}

/**
 * A payload record of the amendment whose index bytes hash to `indexDigest` (an amendment is known
 * only by that digest, design §8.16 step 6), or `undefined`.
 *
 * @example
 * readAmendmentRecord(link.amendment_index_sha256, amendments, AMENDMENT_PATHS.billingImport, 'billing_import', deps);
 */
export function readAmendmentRecord<K extends ProbeRecordType>(
  indexDigest: Sha256Hex,
  amendments: readonly AmendmentSnapshot[],
  path: string,
  recordType: K,
  deps: ProbeRecordDeps,
): ProbeRecordByType[K] | undefined {
  const amendment = amendments.find((snapshot) => {
    const index = fileAt(snapshot.files, AMENDMENT_PATHS.amendmentIndex);
    return index !== undefined && deps.digest(index.bytes) === indexDigest;
  });
  return amendment === undefined ? undefined : readProbeRecord(amendment.files, path, recordType, deps)?.record;
}
