// The final package index (BR-RUA-044; design §7): written last, it hashes every finalized package
// file except itself, late evidence, cleanup, summaries and the complete coordination journal
// included. Package eligibility is computed only after it exists, by the package verifier.

import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { ExecutionIdentity, Result, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { PackageIdentity, PackageIndex } from '../record-contract/records/group-c/package_index.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { classifyPackageArtifact, invalidPathReason } from './artifact-classification.ts';
import { buildIndexEntries, coreFileMissing, duplicatePathReasons, fileAt } from './index-entries.ts';
import type { PackageFile } from './package-file-system.ts';
import { EXECUTION_PATHS } from './package-layout.ts';
import { parsePackageRecord } from './package-records.ts';

export interface PackageIndexInput {
  /** Every finalized file of the package; a `package-index.json` among them is never indexed. */
  readonly files: readonly PackageFile[];
  readonly identity: ExecutionIdentity;
  readonly created_at: UtcMillis;
}

/**
 * Builds the package index, or every reason it cannot be built: an invalid or duplicate path, an
 * unclassifiable file, or an absent execution manifest (its digest is part of the index).
 *
 * @example
 * const index = buildPackageIndex({ files, identity: { execution_kind: 'RUN', run_id }, created_at });
 * if (index.ok) await fs.writeOnce(`${dir}/package-index.json`, serializeRecordFile(index.value));
 */
export function buildPackageIndex(input: PackageIndexInput): Result<PackageIndex, readonly StructuredReason[]> {
  const indexed = input.files.filter((file) => file.path !== EXECUTION_PATHS.packageIndex);
  const pathReasons = [
    ...duplicatePathReasons(indexed),
    ...indexed.flatMap((file) => invalidPathReason(file.path) ?? []),
  ];
  if (pathReasons.length > 0) {
    return err(pathReasons);
  }
  const manifest = fileAt(indexed, EXECUTION_PATHS.executionManifest);
  const entries = buildIndexEntries(indexed, classifyPackageArtifact);
  const reasons = [
    ...(manifest === undefined ? [coreFileMissing(EXECUTION_PATHS.executionManifest)] : []),
    ...(entries.ok ? [] : entries.error),
  ];
  if (manifest === undefined || !entries.ok) {
    return err(reasons);
  }
  return ok({
    schema_version: 1,
    record_type: 'package_index',
    ...packageIdentity(input.identity),
    execution_manifest_sha256: sha256Hex(manifest.bytes),
    entries: entries.value,
    created_at: input.created_at,
  });
}

/**
 * Parses `package-index.json` bytes into a schema-valid package index; total over any bytes.
 *
 * @example
 * const index = parsePackageIndex(await read('runs/<id>/package-index.json'), validator);
 */
export function parsePackageIndex(
  bytes: Uint8Array,
  validator: RecordValidator,
): Result<PackageIndex, StructuredReason> {
  return parsePackageRecord(bytes, 'package_index', validator, EXECUTION_PATHS.packageIndex);
}

/**
 * The `execution_kind` plus the one identity field a package index carries.
 *
 * @example
 * packageIdentity({ execution_kind: 'RUN', run_id }); // { execution_kind: 'RUN', run_id }
 */
export function packageIdentity(identity: ExecutionIdentity): PackageIdentity {
  switch (identity.execution_kind) {
    case 'RUN':
      return { execution_kind: 'RUN', run_id: identity.run_id };
    case 'TRANSPORT_PROBE':
      return { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: identity.transport_probe_id };
    case 'VARIANT_VALIDATION':
      return { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: identity.variant_validation_id };
  }
}
