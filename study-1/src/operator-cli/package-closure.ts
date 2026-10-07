// What a finalized package says about its own closure (design §7, §8.13, §8.17, §10.4; BR-RUA-038,
// BR-RUA-043, BR-RUA-047), as `late-evidence assess` and `billing import` read it:
// - the digest of the original `package-index.json` every amendment chains to;
// - the frozen resource manifest, when P2 froze one;
// - the first mutation: the runner journal's LEASE_ACQUISITION `started` event, journaled just
//   before the lease write (earlier than the write itself, so a window built on it is never short);
// - the effective closure: the original cleanup and audit statuses, replaced by the recovered
//   closure of the last whole OPERATIONAL_RECOVERY amendment chained to this package;
// - the cleanup terminal instant: the latest of the original cleanup's completion and every whole
//   recovery's completion.
// A recovery amendment counts only when its index is a valid `amendment_index` of this execution
// manifest and package index and its record's bytes match the digest the index gives them; any
// other amendment is ignored here (the verifier, not this reader, judges amendments). Package bytes
// are untrusted (A-05): every read is total and a missing record is simply absent.

import { readAmendmentSnapshots } from '../evidence-package/package-snapshot.ts';
import type { AmendmentSnapshot } from '../evidence-package/amendment-snapshots.ts';
import { fileAt } from '../evidence-package/index-entries.ts';
import type { PackageFile, PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { AMENDMENT_PATHS, EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { readClosureRecords } from '../execution-lifecycle/closure-records.ts';
import type { AdmittedExecution } from '../execution-lifecycle/execution-ports.ts';
import { ExecutionPackage, filesByPath } from '../execution-lifecycle/execution-package.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { StudyRecord } from '../record-contract/records/index.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type { AmendmentIndex } from '../record-contract/records/group-c/amendment_index.ts';
import type { OperationalRecoveryRecord } from '../record-contract/records/group-c/operational_recovery_record.ts';
import type { RecordType } from '../record-contract/record-types.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { readRecordFile } from '../study-comparison/record-files.ts';

/** The closure statuses in force: the last whole recovery's, else the original package's. */
export interface EffectiveClosure {
  readonly cleanup_status?: string;
  readonly leak_audit_status?: string;
  /** True when a whole recovery amendment replaced the original closure. */
  readonly recovered: boolean;
}

/** What a finalized package says about its closure. */
export interface PackageClosure {
  readonly files: readonly PackageFile[];
  readonly index_sha256: Sha256Hex;
  readonly resource_manifest?: ResourceManifest;
  readonly first_mutation_at?: UtcMillis;
  readonly cleanup_terminal_at?: UtcMillis;
  readonly closure: EffectiveClosure;
}

/**
 * Reads the closure of a finalized package, or why it cannot be read.
 *
 * @example
 * const closure = await readPackageClosure(files, admitted, validator);
 * if (closure.ok) closure.value.closure.cleanup_status; // 'succeeded' after a clean cleanup
 */
export async function readPackageClosure(
  files: PackageFileSystem,
  admitted: AdmittedExecution,
  validator: RecordValidator,
): Promise<Result<PackageClosure, StructuredReason>> {
  const snapshot = await new ExecutionPackage(files, admitted.identity, admitted.package_directory).snapshot();
  if (!snapshot.ok) {
    return snapshot;
  }
  const byPath = filesByPath(snapshot.value);
  const index = byPath.get(EXECUTION_PATHS.packageIndex);
  if (index === undefined) {
    return err(
      closureReason(
        'PACKAGE_NOT_FINALIZED',
        `${admitted.package_directory} has no package-index.json; expected a finalized package`,
      ),
    );
  }
  const amendments = await readAmendmentSnapshots(files, admitted.identity);
  if (!amendments.ok) {
    return err(
      closureReason(
        'AMENDMENTS_UNREADABLE',
        `the amendments of ${admitted.package_directory} could not be read (${amendments.error.code}: ${amendments.error.detail}); expected a readable amendments directory`,
      ),
    );
  }
  const indexSha256 = sha256Hex(index);
  const deps = { validator, digest: sha256Hex };
  const records = readClosureRecords(byPath, admitted.manifest_sha256, deps);
  const recoveries = amendments.value
    .toSorted((a, b) => (a.directory < b.directory ? -1 : 1))
    .flatMap((amendment) => wholeRecovery(amendment, admitted, indexSha256, validator) ?? []);
  const resourceManifest = readRecordFile(byPath, EXECUTION_PATHS.resourceManifest, 'resource_manifest', deps);
  const firstMutation = records.runner_events.find(
    (event) =>
      event.record_type === 'phase_transition_recorded' &&
      event.phase === 'LEASE_ACQUISITION' &&
      event.status === 'started',
  );
  const terminal = [records.cleanup?.record.completed_at, ...recoveries.map((recovery) => recovery.completed_at)]
    .filter((instant): instant is UtcMillis => instant !== undefined)
    .toSorted()
    .at(-1);
  const last = recoveries.at(-1);
  return ok({
    files: snapshot.value,
    index_sha256: indexSha256,
    ...(resourceManifest.status === 'read' ? { resource_manifest: resourceManifest.frozen.record } : {}),
    ...(firstMutation === undefined ? {} : { first_mutation_at: firstMutation.occurred_at }),
    ...(terminal === undefined ? {} : { cleanup_terminal_at: terminal }),
    closure:
      last === undefined
        ? {
            ...optional('cleanup_status', records.cleanup?.record.cleanup_status),
            ...optional('leak_audit_status', records.leak_audit?.record.leak_audit_status),
            recovered: false,
          }
        : {
            cleanup_status: last.recovered_closure.cleanup_status,
            leak_audit_status: last.recovered_closure.leak_audit_status,
            recovered: true,
          },
  });
}

/**
 * Whether the effective closure proves the execution's resources gone: cleanup `succeeded` and
 * the leak audit `clean`. Its tables can then no longer be read.
 *
 * @example
 * resourcesProvenGone({ cleanup_status: 'succeeded', leak_audit_status: 'clean', recovered: false }); // true
 */
export function resourcesProvenGone(closure: EffectiveClosure): boolean {
  return closure.cleanup_status === 'succeeded' && closure.leak_audit_status === 'clean';
}

// The recovery record of a whole OPERATIONAL_RECOVERY amendment of this package, else undefined.
function wholeRecovery(
  amendment: AmendmentSnapshot,
  admitted: AdmittedExecution,
  indexSha256: Sha256Hex,
  validator: RecordValidator,
): OperationalRecoveryRecord | undefined {
  const index = recordOf(amendment.files, AMENDMENT_PATHS.amendmentIndex, 'amendment_index', validator) as
    AmendmentIndex | undefined;
  const chained =
    index?.amendment_kind === 'OPERATIONAL_RECOVERY' &&
    index.original_package_index_sha256 === indexSha256 &&
    index.execution_manifest_sha256 === admitted.manifest_sha256;
  const path = AMENDMENT_PATHS.operationalRecoveryRecord;
  const entry = chained ? index.entries.find((candidate) => candidate.artifact_path === path) : undefined;
  const bytes = fileAt(amendment.files, path)?.bytes;
  if (entry === undefined || bytes === undefined || sha256Hex(bytes) !== entry.sha256) {
    return undefined;
  }
  return recordOf(amendment.files, path, 'operational_recovery_record', validator) as
    OperationalRecoveryRecord | undefined;
}

function recordOf(
  files: readonly PackageFile[],
  path: string,
  recordType: RecordType,
  validator: RecordValidator,
): StudyRecord | undefined {
  const bytes = fileAt(files, path)?.bytes;
  const parsed = bytes === undefined ? undefined : parseJsonDocument(bytes);
  const checked = parsed?.ok === true ? validator.validateAs(recordType, parsed.value) : undefined;
  return checked?.valid === true ? checked.record : undefined;
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function closureReason(code: string, detail: string): StructuredReason {
  return { code, subject: 'BR-RUA-043', detail };
}
