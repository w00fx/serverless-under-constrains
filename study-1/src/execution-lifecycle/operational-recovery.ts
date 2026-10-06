// Operational recovery, `rua recover <package>` (design §10.4, §11; BR-RUA-038, BR-RUA-043): against
// a finalized package, cleanup steps 3 to 11 run again from the package's cleanup journal (a step the
// journal shows as succeeded is skipped, the audit always reruns), and the lease is released after a
// clean recovered closure or stays marked for recovery. The package is never rewritten: everything
// recovery produces goes into one `OPERATIONAL_RECOVERY` amendment, its payload first and its index
// last. Recovery repairs only cleanup, leak audit and lease; it never reassesses late evidence
// (steps 1 and 2 report `skipped`), a verdict or a summary.

import type { CleanupSafetyClock, StepReport } from '../cleanup/cleanup-ports.ts';
import { readCleanupHistory } from '../cleanup/cleanup-history.ts';
import { CleanupOrchestrator } from '../cleanup/cleanup-orchestrator.ts';
import type { CleanupRunOutcome } from '../cleanup/cleanup-orchestrator.ts';
import { finalizeLease } from '../coordination-lease/lease-finalization.ts';
import type { LeaseStorePort } from '../coordination-lease/lease-store-port.ts';
import { leaseOwnerOf } from '../coordination-lease/lease-store-port.ts';
import { createJsonlJournalPort } from '../event-journal/jsonl-journal-port.ts';
import { JournalWriter } from '../event-journal/journal-writer.ts';
import { buildAmendment } from '../evidence-package/amendments.ts';
import type { PackageFile, PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { AMENDMENT_PATHS, EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { readAmendmentSnapshots } from '../evidence-package/package-snapshot.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type {
  OperationalClosure,
  OperationalRecoveryRecord,
} from '../record-contract/records/group-c/operational_recovery_record.ts';
import type { LeaseEvent } from '../record-contract/records/group-b/vocabulary.ts';
import type {
  CleanupStatus,
  LeaseStatus,
  TerminalCleanupStatus,
} from '../record-contract/records/group-c/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { readJournalRecords, readRecordFile } from '../study-comparison/record-files.ts';
import { finalLeaseStatus } from '../study-comparison/run-terminal-reason.ts';
import { RUNNER_DEFINITIVE_RETRIES } from '../trial-execution/runner-trial-journal.ts';
import { AmendmentPayload } from './amendment-payload.ts';
import { ExecutionCleanupEvidence } from './cleanup-evidence.ts';
import { planCleanup } from './cleanup-plan.ts';
import type {
  AdmittedExecution,
  CleanupBindings,
  ExecutionEvidenceReaders,
  ExecutionServices,
} from './execution-ports.ts';
import { ExecutionPackage, filesByPath } from './execution-package.ts';
import { executionTargetsOf } from './execution-targets.ts';
import type { LateEvidenceSteps } from './late-evidence-freeze.ts';

/** What recovery acts through: the same cleanup bindings as the runner, and the lease store. */
export interface RecoveryDeps {
  readonly files: PackageFileSystem;
  readonly lease: LeaseStorePort;
  readonly cleanup: CleanupBindings;
  readonly readers: ExecutionEvidenceReaders;
  readonly safety: CleanupSafetyClock;
  readonly services: ExecutionServices;
}

/** The amendment recovery wrote. */
export interface RecoveryOutcome {
  readonly amendment_directory: string;
  readonly record: OperationalRecoveryRecord;
}

const TERMINAL_CLEANUP: ReadonlySet<CleanupStatus> = new Set<CleanupStatus>(['succeeded', 'partial', 'failed']);
const RECOVERY_STEPS = { first: 3, last: 11 } as const;

// The lease events a finalization settles on; any other leaves the lease unverified (BR-RUA-045).
const REPAIRED_LEASE_STATUS: Readonly<Partial<Record<LeaseEvent, LeaseStatus>>> = {
  RELEASED: 'released',
  RECOVERY_REQUIRED: 'recovery_required',
};

const RECOVERY_PATHS = {
  pre_cleanup_snapshot: AMENDMENT_PATHS.preCleanupSnapshot,
  cleanup_result: AMENDMENT_PATHS.cleanupResult,
  leak_audit_result: AMENDMENT_PATHS.leakAuditResult,
} as const;

// Recovery never reassesses late evidence (BR-RUA-038).
const LATE_EVIDENCE_OUT_OF_SCOPE: LateEvidenceSteps = {
  cutoff: () => Promise.resolve(outOfScope()),
  freezeAssessment: () => Promise.resolve(outOfScope()),
};

/**
 * Recovers a finalized package's cleanup, leak audit and lease into an `OPERATIONAL_RECOVERY`
 * amendment, or every reason it cannot.
 *
 * @example
 * const recovered = await recoverExecution(admitted, deps);
 * if (recovered.ok) recovered.value.record.recovered_closure.lease_status; // 'released'
 */
export async function recoverExecution(
  admitted: AdmittedExecution,
  deps: RecoveryDeps,
): Promise<Result<RecoveryOutcome, readonly StructuredReason[]>> {
  const { services } = deps;
  const startedAt = formatUtcMillis(services.clock.now());
  const pkg = new ExecutionPackage(deps.files, admitted.identity, admitted.package_directory);
  const original = await readOriginal(pkg, admitted, services);
  if (!original.ok) {
    return original;
  }
  const payload = new AmendmentPayload();
  const cleanup = await rerunCleanup(admitted, original.value, pkg, payload, deps);
  if (!cleanup.ok) {
    return err([cleanup.error]);
  }
  const { cleanup_result: result, leak_audit_result: audit } = cleanup.value;
  const recoveredCleanup = terminalStatus(result.cleanup_status);
  const clean = recoveredCleanup === 'succeeded' && audit.leak_audit_status === 'clean';
  const lease = await repairLease(admitted, original.value.closure.lease_status, clean, deps);
  const record: OperationalRecoveryRecord = {
    schema_version: 1,
    record_type: 'operational_recovery_record',
    ...executionIdentityFields(admitted.identity),
    execution_manifest_sha256: admitted.manifest_sha256,
    recovery_id: services.ids.next(),
    original_package_index_sha256: original.value.index_sha256,
    original_closure: original.value.closure,
    recovered_closure: {
      cleanup_status: recoveredCleanup,
      leak_audit_status: audit.leak_audit_status,
      lease_status: lease.status,
    },
    steps_run: stepsRun(payload, admitted, services),
    cleanup_result_ref: payloadRef(payload, AMENDMENT_PATHS.cleanupResult),
    leak_audit_result_ref: payloadRef(payload, AMENDMENT_PATHS.leakAuditResult),
    reasons: [...original.value.reasons, ...cleanup.value.freeze.reasons, ...lease.reasons],
    started_at: startedAt,
    completed_at: formatUtcMillis(services.clock.now()),
  };
  await payload.writeOnce(AMENDMENT_PATHS.operationalRecoveryRecord, serializeRecordFile(record));
  const written = await writeAmendment(admitted, original.value.index_sha256, payload.files(), deps);
  return written.ok ? ok({ amendment_directory: written.value, record }) : written;
}

/** What recovery reads of the finalized package. */
interface OriginalPackage {
  readonly index_sha256: Sha256Hex;
  readonly resource_manifest: ResourceManifest;
  readonly cleanup_journal: Uint8Array;
  readonly closure: OperationalClosure;
  readonly reasons: readonly StructuredReason[];
}

async function readOriginal(
  pkg: ExecutionPackage,
  admitted: AdmittedExecution,
  services: ExecutionServices,
): Promise<Result<OriginalPackage, readonly StructuredReason[]>> {
  const snapshot = await pkg.snapshot();
  if (!snapshot.ok) {
    return err([snapshot.error]);
  }
  const files = filesByPath(snapshot.value);
  const deps = { validator: services.validator, digest: sha256Hex };
  const index = files.get(EXECUTION_PATHS.packageIndex);
  const manifest = readRecordFile(files, EXECUTION_PATHS.resourceManifest, 'resource_manifest', deps);
  if (index === undefined) {
    return err([
      recoveryReason(
        'PACKAGE_NOT_FINALIZED',
        `${admitted.package_directory} has no package-index.json; expected a finalized package`,
      ),
    ]);
  }
  if (manifest.status !== 'read') {
    return err([
      recoveryReason(
        'RESOURCE_MANIFEST_UNREADABLE',
        `${admitted.package_directory} has no readable resource manifest; expected the record of what the execution deployed`,
      ),
    ]);
  }
  const cleanup = readRecordFile(files, EXECUTION_PATHS.cleanupResult, 'cleanup_result', deps);
  const audit = readRecordFile(files, EXECUTION_PATHS.leakAuditResult, 'leak_audit_result', deps);
  const lease = readJournalRecords(files, EXECUTION_PATHS.coordinationJournal, ['lease_event_recorded'], deps);
  return ok({
    index_sha256: sha256Hex(index),
    resource_manifest: manifest.frozen.record,
    cleanup_journal: files.get(EXECUTION_PATHS.cleanupJournal) ?? new Uint8Array(),
    closure: {
      cleanup_status: cleanup.status === 'read' ? terminalStatus(cleanup.frozen.record.cleanup_status) : 'failed',
      leak_audit_status: audit.status === 'read' ? audit.frozen.record.leak_audit_status : 'inconclusive',
      lease_status: finalLeaseStatus(lease.records),
    },
    reasons: lease.reasons,
  });
}

async function rerunCleanup(
  admitted: AdmittedExecution,
  original: OriginalPackage,
  pkg: ExecutionPackage,
  payload: AmendmentPayload,
  deps: RecoveryDeps,
): Promise<Result<CleanupRunOutcome, StructuredReason>> {
  const { services } = deps;
  const correlation = { execution: admitted.identity, execution_manifest_sha256: admitted.manifest_sha256 };
  const targets = executionTargetsOf(original.resource_manifest);
  const plan = planCleanup({
    admitted,
    resource_manifest: original.resource_manifest,
    targets: targets.ok ? targets.value : undefined,
    history: readCleanupHistory(original.cleanup_journal, correlation, services.validator),
    started_at: original.resource_manifest.deploy_started_at,
  });
  if (!plan.ok) {
    return plan;
  }
  const orchestrator = new CleanupOrchestrator({
    ...deps.cleanup,
    evidence: new ExecutionCleanupEvidence({
      pkg,
      sink: payload,
      paths: RECOVERY_PATHS,
      late: LATE_EVIDENCE_OUT_OF_SCOPE,
      readers: deps.readers,
      snapshot: plan.value.snapshot,
      services,
    }),
    journal: new JournalWriter({
      port: createJsonlJournalPort(AMENDMENT_PATHS.cleanupJournal, payload),
      source: 'cleanup',
      instanceId: services.ids.next(),
      scope: { ...correlation, partition: { kind: 'execution' } },
      clock: services.clock,
      ids: services.ids,
      maxDefinitiveRetries: RUNNER_DEFINITIVE_RETRIES,
    }),
    safety: deps.safety,
    clock: services.clock,
  });
  // Consumers stop first, as after any interruption: recovery runs the emergency order.
  return ok(await orchestrator.runEmergency(plan.value.input));
}

// A lease the original closure released stays released. The lease item is shared by every
// execution, so a later one may hold it now; reading its owner as this execution's would turn a
// proven release into `unverified`, and recovery repairs a closure, it never degrades it.
async function repairLease(
  admitted: AdmittedExecution,
  original: LeaseStatus,
  clean: boolean,
  deps: RecoveryDeps,
): Promise<{ readonly status: LeaseStatus; readonly reasons: readonly StructuredReason[] }> {
  if (original === 'released') {
    return { status: 'released', reasons: [] };
  }
  const verdict = await finalizeLease({
    store: deps.lease,
    owner: leaseOwnerOf(admitted.identity, admitted.manifest_sha256),
    closure: clean ? 'clean' : 'unclean',
    // Used only when the pre-finalization read fails; the conditional write then decides.
    known_version: 0,
    held: true,
    now: () => formatUtcMillis(deps.services.clock.now()),
  });
  const status = REPAIRED_LEASE_STATUS[verdict.lease_event] ?? 'unverified';
  return {
    status,
    reasons:
      status === 'unverified'
        ? [recoveryReason('LEASE_NOT_REPAIRED', `${verdict.lease_event}: ${verdict.detail}`)]
        : [],
  };
}

// Steps 3-11 this recovery journaled as started, ascending (`steps_run`).
function stepsRun(
  payload: AmendmentPayload,
  admitted: AdmittedExecution,
  services: ExecutionServices,
): readonly number[] {
  const history = readCleanupHistory(
    payload.bytesAt(AMENDMENT_PATHS.cleanupJournal),
    { execution: admitted.identity, execution_manifest_sha256: admitted.manifest_sha256 },
    services.validator,
  );
  const steps = history.entries
    .filter(
      ({ body }) =>
        body.step_status === 'started' && body.step >= RECOVERY_STEPS.first && body.step <= RECOVERY_STEPS.last,
    )
    .map(({ body }) => body.step);
  return [...new Set(steps)].toSorted((a, b) => a - b);
}

async function writeAmendment(
  admitted: AdmittedExecution,
  originalIndexSha256: Sha256Hex,
  payload: readonly PackageFile[],
  deps: RecoveryDeps,
): Promise<Result<string, readonly StructuredReason[]>> {
  const existing = await readAmendmentSnapshots(deps.files, admitted.identity);
  if (!existing.ok) {
    return err([recoveryReason('AMENDMENTS_UNREADABLE', `${existing.error.code}: ${existing.error.detail}`)]);
  }
  const parent = existing.value
    .toSorted((a, b) => (a.directory < b.directory ? -1 : 1))
    .at(-1)
    ?.files.find((file) => file.path === AMENDMENT_PATHS.amendmentIndex);
  const built = buildAmendment({
    identity: admitted.identity,
    execution_manifest_sha256: admitted.manifest_sha256,
    amendment_id: deps.services.ids.next(),
    amendment_kind: 'OPERATIONAL_RECOVERY',
    sequence: existing.value.length + 1,
    original_package_index_sha256: originalIndexSha256,
    parent_amendment_index_sha256: parent === undefined ? null : sha256Hex(parent.bytes),
    payload,
    created_at: formatUtcMillis(deps.services.clock.now()),
  });
  if (!built.ok) {
    return built;
  }
  for (const file of built.value.files) {
    const written = await deps.files.writeOnce(`${built.value.directory}/${file.path}`, file.bytes);
    if (!written.ok) {
      return err([
        recoveryReason(
          'AMENDMENT_NOT_WRITTEN',
          `${built.value.directory}/${file.path}: ${written.error.code}: ${written.error.detail}`,
        ),
      ]);
    }
  }
  return ok(built.value.directory);
}

// A cleanup result that never reached a terminal status counts as failed (BR-RUA-038 repairs only
// terminal values).
function terminalStatus(status: CleanupStatus): TerminalCleanupStatus {
  return TERMINAL_CLEANUP.has(status) ? (status as TerminalCleanupStatus) : 'failed';
}

function payloadRef(
  payload: AmendmentPayload,
  path: string,
): { readonly artifact_path: string; readonly artifact_sha256: Sha256Hex } {
  return { artifact_path: path, artifact_sha256: sha256Hex(payload.bytesAt(path)) };
}

function outOfScope(): StepReport {
  return {
    status: 'skipped',
    reasons: [
      recoveryReason(
        'OUTSIDE_RECOVERY_SCOPE',
        'recovery repairs only cleanup, leak audit and lease; expected late evidence untouched',
      ),
    ],
  };
}

function recoveryReason(code: string, detail: string): StructuredReason {
  return { code, subject: 'BR-RUA-038', detail };
}
