// The OPERATIONAL_RECOVERY amendment of AC-RUA-038 (BR-RUA-038, BR-RUA-043): after the original
// package was sealed with a failed cleanup, a leaked source queue and a lease marked for recovery,
// a recovery reran cleanup, found nothing left and released the lease. Its payload holds the rerun
// cleanup result, the clean audit and the recovery record citing both by their exact bytes; the
// amendment itself is built by the WP-13 amendment builder, so its index is the production index.

import { serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { Sha256Hex, Uuid4, UtcMillis } from '../../../../src/record-contract/primitives.ts';
import type { CleanupResult } from '../../../../src/record-contract/records/group-c/cleanup_result.ts';
import type { LeakAuditResult } from '../../../../src/record-contract/records/group-c/leak_audit_result.ts';
import type {
  OperationalClosure,
  OperationalRecoveryRecord,
} from '../../../../src/record-contract/records/group-c/operational_recovery_record.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import type { AmendmentSnapshot } from '../../../../src/evidence-package/amendment-snapshots.ts';
import { buildAmendment } from '../../../../src/evidence-package/amendments.ts';
import type { PackageFile } from '../../../../src/evidence-package/package-file-system.ts';
import { AMENDMENT_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { RUN_ID } from './run-fixture.ts';

const AMENDMENT_ID = '3f8b2a1c-9d4e-4f6a-8b7c-2e1d0a9f8c7b' as Uuid4;
const RECOVERY_ID = '5c2e9a7b-1f3d-4b8e-9a6c-7d0e1f2a3b4c' as Uuid4;
const at = (text: string): UtcMillis => text as UtcMillis;

/** A built recovery amendment, as stored and as the verifier selects it. */
export interface RecoveryAmendment {
  readonly snapshot: AmendmentSnapshot;
  readonly index_sha256: Sha256Hex;
}

/** What the recovery found the closure to be, and what it left it as. */
export interface RecoveryClosures {
  readonly original: OperationalClosure;
  readonly recovered: OperationalClosure;
}

/**
 * Builds the sequence-1 recovery amendment of a sealed original package; throws when the builder
 * refuses it (a broken fixture, not a finding).
 *
 * @example
 * recoveryAmendment(manifestSha256, sealed.package_index_sha256, { original, recovered }).index_sha256;
 */
export function recoveryAmendment(
  manifestSha256: Sha256Hex,
  originalIndexSha256: Sha256Hex,
  closures: RecoveryClosures,
): RecoveryAmendment {
  const correlation = { run_id: RUN_ID, execution_manifest_sha256: manifestSha256 } as const;
  const cleanup = jsonFile(AMENDMENT_PATHS.cleanupResult, rerunCleanup(correlation));
  const audit = jsonFile(AMENDMENT_PATHS.leakAuditResult, cleanAudit(correlation));
  const record: OperationalRecoveryRecord = {
    schema_version: 1,
    record_type: 'operational_recovery_record',
    ...correlation,
    recovery_id: RECOVERY_ID,
    original_package_index_sha256: originalIndexSha256,
    original_closure: closures.original,
    recovered_closure: closures.recovered,
    steps_run: [9, 10, 11],
    cleanup_result_ref: { artifact_path: cleanup.path, artifact_sha256: sha256Hex(cleanup.bytes) },
    leak_audit_result_ref: { artifact_path: audit.path, artifact_sha256: sha256Hex(audit.bytes) },
    reasons: [],
    started_at: at('2026-10-05T15:00:00.000Z'),
    completed_at: at('2026-10-05T15:20:00.000Z'),
  };
  const built = buildAmendment({
    identity: { execution_kind: 'RUN', run_id: RUN_ID },
    execution_manifest_sha256: manifestSha256,
    amendment_id: AMENDMENT_ID,
    amendment_kind: 'OPERATIONAL_RECOVERY',
    sequence: 1,
    original_package_index_sha256: originalIndexSha256,
    parent_amendment_index_sha256: null,
    payload: [jsonFile(AMENDMENT_PATHS.operationalRecoveryRecord, record), cleanup, audit],
    created_at: at('2026-10-05T15:21:00.000Z'),
  });
  if (!built.ok) {
    throw new Error(`the recovery amendment cannot be built: ${JSON.stringify(built.error)}`);
  }
  const index = built.value.files.find((file) => file.path === AMENDMENT_PATHS.amendmentIndex);
  if (index === undefined) {
    throw new Error(`the built amendment has no ${AMENDMENT_PATHS.amendmentIndex}`);
  }
  return {
    snapshot: { directory: `0001-${AMENDMENT_ID}`, files: built.value.files, special_entries: [] },
    index_sha256: sha256Hex(index.bytes),
  };
}

function jsonFile(path: string, record: StudyRecord): PackageFile {
  return { path, bytes: serializeRecordFile(record) };
}

interface Correlation {
  readonly run_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
}

function rerunCleanup(correlation: Correlation): CleanupResult {
  return {
    schema_version: 1,
    record_type: 'cleanup_result',
    ...correlation,
    cleanup_mode: 'NORMAL',
    cleanup_status: 'succeeded',
    steps: [
      {
        step: 9,
        status: 'succeeded',
        started_at: at('2026-10-05T15:00:00.000Z'),
        completed_at: at('2026-10-05T15:08:00.000Z'),
        reasons: [],
      },
    ],
    resources: [],
    stopped_durable_execution_arns: [],
    deleted_dlq_message_ids: [],
    duration_breach: false,
    started_at: at('2026-10-05T15:00:00.000Z'),
    completed_at: at('2026-10-05T15:08:00.000Z'),
  };
}

function cleanAudit(correlation: Correlation): LeakAuditResult {
  const pass = (start: string, end: string): LeakAuditResult['passes'][number] => ({
    started_at: at(start),
    completed_at: at(end),
    surfaces: [
      { surface: 'tag_index', query_ok: true, observed: [] },
      { surface: 'functions', query_ok: true, observed: [] },
    ],
  });
  return {
    schema_version: 1,
    record_type: 'leak_audit_result',
    ...correlation,
    leak_audit_status: 'clean',
    passes: [
      pass('2026-10-05T15:08:30.000Z', '2026-10-05T15:08:40.000Z'),
      pass('2026-10-05T15:10:40.000Z', '2026-10-05T15:10:50.000Z'),
    ],
    leaks: [],
    ambiguous: [],
    stable_absence_interval_ms: 120_000,
    audited_at: at('2026-10-05T15:10:50.000Z'),
  };
}
