// The execution-level records a probe or validation summary cites at P9 (design §10.2; CTR-RUA-003,
// BR-RUA-038), read back from the package the runner wrote: the cleanup result, the leak audit, the
// safety assessment, the late-evidence assessment, and the runner and coordination journal events
// the terminal reason is derived from (the runner's P9 safety checks apart, since only a validation
// has a terminal reason for a breached limit). The bytes are read as untrusted (A-05): a file that cannot be
// read, or a record of another execution manifest, is reported and treated as absent, and the
// summary writer judges the absence. A run reads the same records through `readRunPackage`.

import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import type { Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { LeaseEventRecorded } from '../record-contract/records/group-b/lease_event_recorded.ts';
import type { SafetyCheckRecorded } from '../record-contract/records/group-b/safety_check_recorded.ts';
import type { CleanupResult } from '../record-contract/records/group-c/cleanup_result.ts';
import type { LateEvidenceAssessment } from '../record-contract/records/group-c/late_evidence_assessment.ts';
import type { LeakAuditResult } from '../record-contract/records/group-c/leak_audit_result.ts';
import type { SafetyAssessment } from '../record-contract/records/group-c/safety_assessment.ts';
import { readJournalRecords, readRecordFile } from '../study-comparison/record-files.ts';
import type {
  FrozenRecord,
  PackageFiles,
  RecordReadingDeps,
  StudyComparisonRecords,
} from '../study-comparison/record-files.ts';
import type { RunnerEvent } from '../study-comparison/run-terminal-reason.ts';

/** What a probe or validation summary reads besides its own unit evidence. */
export interface ExecutionClosureRecords {
  readonly cleanup: FrozenRecord<CleanupResult> | undefined;
  readonly leak_audit: FrozenRecord<LeakAuditResult> | undefined;
  readonly safety: FrozenRecord<SafetyAssessment> | undefined;
  readonly late_evidence: FrozenRecord<LateEvidenceAssessment> | undefined;
  /** Runner phase and interruption events, in file order. */
  readonly runner_events: readonly RunnerEvent[];
  /** The runner's `safety_check_recorded` events, in file order. */
  readonly safety_checks: readonly SafetyCheckRecorded[];
  /** Coordination lease events, in file order. */
  readonly lease_events: readonly LeaseEventRecorded[];
  /** Every file or line that could not be read, and every record of another manifest. */
  readonly reasons: readonly StructuredReason[];
}

/** The closure records a summary may require. */
export type SummaryInput = 'cleanup' | 'late_evidence' | 'safety';

type ClosureRecordType = 'cleanup_result' | 'leak_audit_result' | 'safety_assessment' | 'late_evidence_assessment';

const SUMMARY_INPUT_PATHS: Readonly<Record<SummaryInput, string>> = {
  cleanup: EXECUTION_PATHS.cleanupResult,
  late_evidence: EXECUTION_PATHS.lateEvidenceAssessment,
  safety: EXECUTION_PATHS.safetyAssessment,
};

/**
 * Reads the closure records of the execution frozen under `manifestSha256`.
 *
 * @example
 * const closure = readClosureRecords(filesByPath(files), admitted.manifest_sha256, { validator, digest: sha256Hex });
 * closure.cleanup?.record.cleanup_status; // 'succeeded' after a clean normal cleanup
 */
export function readClosureRecords(
  files: PackageFiles,
  manifestSha256: Sha256Hex,
  deps: RecordReadingDeps,
): ExecutionClosureRecords {
  const reasons: StructuredReason[] = [];
  const own = <K extends ClosureRecordType>(
    path: string,
    recordType: K,
  ): FrozenRecord<StudyComparisonRecords[K]> | undefined => {
    const read = readRecordFile(files, path, recordType, deps);
    if (read.status === 'unreadable') {
      reasons.push(read.reason);
    }
    const frozen = read.status === 'read' ? read.frozen : undefined;
    return frozen === undefined || ownedBy(frozen.record, manifestSha256, path, reasons) ? frozen : undefined;
  };
  const runner = readJournalRecords(
    files,
    EXECUTION_PATHS.runnerJournal,
    ['phase_transition_recorded', 'trial_interrupted', 'safety_check_recorded'],
    deps,
  );
  const lease = readJournalRecords(files, EXECUTION_PATHS.coordinationJournal, ['lease_event_recorded'], deps);
  reasons.push(...runner.reasons, ...lease.reasons);
  const records = {
    cleanup: own(EXECUTION_PATHS.cleanupResult, 'cleanup_result'),
    leak_audit: own(EXECUTION_PATHS.leakAuditResult, 'leak_audit_result'),
    safety: own(EXECUTION_PATHS.safetyAssessment, 'safety_assessment'),
    late_evidence: own(EXECUTION_PATHS.lateEvidenceAssessment, 'late_evidence_assessment'),
  };
  const runnerOwned = runner.records.filter((event) =>
    ownedBy(event, manifestSha256, EXECUTION_PATHS.runnerJournal, reasons),
  );
  return {
    ...records,
    runner_events: runnerOwned.filter((event) => event.record_type !== 'safety_check_recorded'),
    safety_checks: runnerOwned.filter((event) => event.record_type === 'safety_check_recorded'),
    lease_events: lease.records.filter((event) =>
      ownedBy(event, manifestSha256, EXECUTION_PATHS.coordinationJournal, reasons),
    ),
    reasons,
  };
}

/**
 * The reasons a summary cannot be written: each closure record it must cite that is absent or
 * unreadable (CTR-RUA-003 and BR-RUA-038 cite the cleanup result and the late-evidence assessment;
 * a validation also builds its status on the safety assessment).
 *
 * @example
 * missingSummaryInputs(closure, ['cleanup', 'late_evidence']); // [] once both are frozen
 */
export function missingSummaryInputs(
  closure: ExecutionClosureRecords,
  required: readonly SummaryInput[],
): readonly StructuredReason[] {
  return required
    .filter((name) => closure[name] === undefined)
    .map((name) => ({
      code: 'SUMMARY_INPUT_MISSING',
      subject: 'BR-RUA-044',
      artifact_path: SUMMARY_INPUT_PATHS[name],
      detail: `${SUMMARY_INPUT_PATHS[name]} is absent or unreadable; expected it frozen before the summary`,
    }));
}

/**
 * Events of the runner and coordination journals merged in time order: the fixed-width UTC
 * millisecond form orders lexically, and events of the same instant keep their given order.
 *
 * @example
 * inJournalTime([...closure.runner_events, ...closure.lease_events]); // earliest event first
 */
export function inJournalTime<T extends { readonly occurred_at: string }>(events: readonly T[]): readonly T[] {
  return events.toSorted((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0));
}

// A record of another execution manifest says nothing about this execution.
function ownedBy(
  record: { readonly execution_manifest_sha256: Sha256Hex },
  manifestSha256: Sha256Hex,
  path: string,
  reasons: StructuredReason[],
): boolean {
  if (record.execution_manifest_sha256 === manifestSha256) {
    return true;
  }
  reasons.push({
    code: 'ARTIFACT_UNREADABLE',
    subject: 'BR-RUA-033',
    artifact_path: path,
    detail: `${path} names execution_manifest_sha256 ${record.execution_manifest_sha256}; expected ${manifestSha256}`,
  });
  return false;
}
