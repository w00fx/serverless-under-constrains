// What every package command reads and writes below the evidence root (design §7, §8.16, §11):
// the original package and every amendment directory found for it, read back as exact bytes; the
// operator's explicit amendment head (`--head`, never selected implicitly); and the verifier
// outputs under `verifications/<execution_id>/`, written once and never inside a package. A file
// system failure is a value naming the path and the failure; the operator input (`--head`) is
// refused as a usage error with the offending value and the expected shape.

import { readAdmittedExecution } from '../execution-lifecycle/admitted-execution.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import type { VerificationKind } from '../evidence-package/package-layout.ts';
import { readAmendmentSnapshots, readPackageSnapshot } from '../evidence-package/package-snapshot.ts';
import type { PackageVerificationInput } from '../evidence-package/package-verifier.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { isSha256Hex } from '../record-contract/digests.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  ExecutionIdentity,
  Result,
  Sha256Hex,
  StructuredReason,
  UtcMillis,
} from '../record-contract/primitives.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { StudyRecord } from '../record-contract/records/index.ts';
import { usageReason } from './arg-parsing.ts';

/** The services a package command reads and writes through. */
export interface PackageCommandDeps {
  /** The evidence file system rooted at the given evidence root. */
  readonly files: (evidenceRoot: string) => PackageFileSystem;
  readonly validator: RecordValidator;
}

/**
 * The amendment head a `--<name> <sha256>` flag selects: `null` when the flag is absent.
 *
 * @example
 * parseDigestFlag('head', undefined); // { ok: true, value: null }
 * parseDigestFlag('head', 'ABC'); // usage error: expected a lowercase SHA-256
 */
export function parseDigestFlag(name: string, value: string | undefined): Result<Sha256Hex | null, StructuredReason> {
  return value === undefined ? ok(null) : parseDigest(name, value);
}

/**
 * The digest a `--<name> <sha256>` operand gives.
 *
 * @example
 * parseDigest('probe-index', sha); // { ok: true, value: sha }
 */
export function parseDigest(name: string, value: string): Result<Sha256Hex, StructuredReason> {
  return isSha256Hex(value)
    ? ok(value)
    : err(usageReason(`--${name} ${boundedJsonText(value)} is not a digest`, '64 lowercase hexadecimal characters'));
}

/**
 * The verifier's input for one package: the original, every amendment found and the head.
 *
 * @example
 * const input = await readVerificationInput(files, identity, null, now);
 * if (input.ok) verifyPackage(input.value, { validator, digest: sha256Hex });
 */
export async function readVerificationInput(
  files: PackageFileSystem,
  identity: ExecutionIdentity,
  head: Sha256Hex | null,
  evaluatedAt: UtcMillis,
  validator: RecordValidator,
): Promise<Result<PackageVerificationInput, StructuredReason>> {
  const original = await readPackageSnapshot(files, identity);
  if (!original.ok) {
    return err(unreadable(PACKAGE_LAYOUT.executionDirectory(identity), original.error));
  }
  const amendments = await readAmendmentSnapshots(files, identity);
  if (!amendments.ok) {
    return err(unreadable(PACKAGE_LAYOUT.amendmentsDirectory(identity), amendments.error));
  }
  return ok({
    identity,
    original: original.value,
    amendments: amendments.value,
    selected_head: head,
    referenced_package_indexes: qualificationIndexes(original.value.files, validator),
    evaluated_at: evaluatedAt,
  });
}

/**
 * Writes one verifier output once and returns its path below the evidence root.
 *
 * @example
 * await writeVerification(files, identity, now, 'package-verification', verification);
 * // { ok: true, value: 'verifications/<id>/<now>-package-verification.json' }
 */
export async function writeVerification(
  files: PackageFileSystem,
  identity: ExecutionIdentity,
  evaluatedAt: UtcMillis,
  kind: VerificationKind,
  record: StudyRecord,
): Promise<Result<string, StructuredReason>> {
  const path = PACKAGE_LAYOUT.verificationPath(identity, evaluatedAt, kind);
  const written = await files.writeOnce(path, serializeRecordFile(record));
  return written.ok ? ok(path) : err(unwritten(path, written.error));
}

// A run or a validation consumed the probe its manifest names; references into that probe's
// package name its index digest, so the verifier may resolve them (BR-RUA-035).
function qualificationIndexes(
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  validator: RecordValidator,
): readonly Sha256Hex[] {
  const bytes = files.find((file) => file.path === EXECUTION_PATHS.executionManifest)?.bytes;
  const admitted = bytes === undefined ? undefined : readAdmittedExecution(bytes, validator);
  if (admitted?.ok !== true || admitted.value.manifest.qualification === null) {
    return [];
  }
  return [admitted.value.manifest.qualification.original_package_index_sha256];
}

function unreadable(path: string, failure: { readonly code: string; readonly detail: string }): StructuredReason {
  return {
    code: 'PACKAGE_UNREADABLE',
    subject: 'BR-RUA-044',
    detail: `${path}: ${failure.code}: ${failure.detail}; expected a readable package directory`,
  };
}

function unwritten(path: string, failure: { readonly code: string; readonly detail: string }): StructuredReason {
  return {
    code: 'VERIFICATION_NOT_WRITTEN',
    subject: 'operator-cli',
    detail: `${path}: ${failure.code}: ${failure.detail}; expected a new verifier output below the evidence root`,
  };
}
