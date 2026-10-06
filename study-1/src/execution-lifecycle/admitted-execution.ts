// The admitted execution a runner executes (design §10.1 A15, §10.2; BR-RUA-019, BR-RUA-028,
// BR-RUA-040, BR-RUA-042; AC-RUA-008). Admission froze the execution manifest before any mutation;
// the runner reads those exact bytes back, validates them against the catalogue schema and keeps
// their digest, so every lease owner, trial plan and record of the execution names the frozen
// bytes and nothing else. The bytes come from disk and are untrusted (A-05): the reader is total
// and refuses with a reason instead of throwing.

import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { ExecutionIdentity, Result, StructuredReason } from '../record-contract/primitives.ts';
import type { ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { readRecordFile } from '../study-comparison/record-files.ts';
import type { AdmittedExecution } from './execution-ports.ts';

/**
 * Reads the frozen execution manifest bytes into the admitted execution, or the reason they are
 * not one valid `execution_manifest` document.
 *
 * @example
 * const admitted = readAdmittedExecution(manifestBytes, createRecordValidator());
 * if (admitted.ok) admitted.value.package_directory; // 'runs/<run_id>'
 */
export function readAdmittedExecution(
  bytes: Uint8Array,
  validator: RecordValidator,
): Result<AdmittedExecution, StructuredReason> {
  const path = EXECUTION_PATHS.executionManifest;
  const read = readRecordFile(new Map([[path, bytes]]), path, 'execution_manifest', { validator, digest: sha256Hex });
  if (read.status !== 'read') {
    // A one-entry map always holds the path, so the read is `unreadable`, never `absent`.
    return err((read as Extract<typeof read, { readonly status: 'unreadable' }>).reason);
  }
  const manifest = read.frozen.record;
  const identity = identityOf(manifest);
  return ok({
    manifest,
    manifest_sha256: read.frozen.ref.artifact_sha256,
    identity,
    package_directory: PACKAGE_LAYOUT.executionDirectory(identity),
  });
}

/**
 * The execution identity a manifest declares.
 *
 * @example
 * identityOf(manifest); // { execution_kind: 'RUN', run_id }
 */
export function identityOf(manifest: ExecutionManifest): ExecutionIdentity {
  switch (manifest.execution_kind) {
    case 'RUN':
      return { execution_kind: 'RUN', run_id: manifest.run_id };
    case 'VARIANT_VALIDATION':
      return { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: manifest.variant_validation_id };
    case 'TRANSPORT_PROBE':
      return { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: manifest.transport_probe_id };
  }
}
