// Writing one amendment package next to a finalized original (BR-RUA-043, BR-RUA-044; design §7
// amendments): the next sequence after every amendment already stored, chained to the last one's
// index digest, built by `buildAmendment` and written file by file, payload first and
// `amendment-index.json` last, each written once. The original package is only read. Operational
// recovery and the late-evidence assessment service both write through it.

import { buildAmendment } from '../evidence-package/amendments.ts';
import type { PackageFile, PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { AMENDMENT_PATHS } from '../evidence-package/package-layout.ts';
import { readAmendmentSnapshots } from '../evidence-package/package-snapshot.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { AmendmentKind } from '../record-contract/records/group-c/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { AdmittedExecution, ExecutionServices } from './execution-ports.ts';

/** One amendment to append to an execution's chain. */
export interface AmendmentWrite {
  readonly admitted: AdmittedExecution;
  readonly kind: AmendmentKind;
  /** The digest of the original `package-index.json`. */
  readonly original_index_sha256: Sha256Hex;
  /** Payload files, relative to the amendment directory. */
  readonly payload: readonly PackageFile[];
  /** The rule a failure is reported under (BR-RUA-038 for recovery, BR-RUA-043 for late evidence). */
  readonly subject: string;
}

/**
 * Writes the amendment; its directory, or every reason it was not written.
 *
 * @example
 * const written = await writeAmendmentPackage(files, services, { admitted, kind: 'LATE_EVIDENCE',
 *   original_index_sha256, payload, subject: 'BR-RUA-043' });
 * if (written.ok) written.value; // 'runs/<run_id>/amendments/0001-<amendment_id>'
 */
export async function writeAmendmentPackage(
  files: PackageFileSystem,
  services: ExecutionServices,
  amendment: AmendmentWrite,
): Promise<Result<string, readonly StructuredReason[]>> {
  const { admitted } = amendment;
  const existing = await readAmendmentSnapshots(files, admitted.identity);
  if (!existing.ok) {
    return err([
      amendmentReason(amendment, 'AMENDMENTS_UNREADABLE', `${existing.error.code}: ${existing.error.detail}`),
    ]);
  }
  const parent = existing.value
    .toSorted((a, b) => (a.directory < b.directory ? -1 : 1))
    .at(-1)
    ?.files.find((file) => file.path === AMENDMENT_PATHS.amendmentIndex);
  const built = buildAmendment({
    identity: admitted.identity,
    execution_manifest_sha256: admitted.manifest_sha256,
    amendment_id: services.ids.next(),
    amendment_kind: amendment.kind,
    sequence: existing.value.length + 1,
    original_package_index_sha256: amendment.original_index_sha256,
    parent_amendment_index_sha256: parent === undefined ? null : sha256Hex(parent.bytes),
    payload: amendment.payload,
    created_at: formatUtcMillis(services.clock.now()),
  });
  if (!built.ok) {
    return built;
  }
  for (const file of built.value.files) {
    const written = await files.writeOnce(`${built.value.directory}/${file.path}`, file.bytes);
    if (!written.ok) {
      return err([
        amendmentReason(
          amendment,
          'AMENDMENT_NOT_WRITTEN',
          `${built.value.directory}/${file.path}: ${written.error.code}: ${written.error.detail}`,
        ),
      ]);
    }
  }
  return ok(built.value.directory);
}

function amendmentReason(amendment: AmendmentWrite, code: string, detail: string): StructuredReason {
  return {
    code,
    subject: amendment.subject,
    detail: `${detail}; expected the ${amendment.kind} amendment written whole`,
  };
}
