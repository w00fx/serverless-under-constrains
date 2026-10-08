// What each of cleanup steps 1-11 does (BR-RUA-048, design §10.4), given the ports, the targets
// and the folded journal. Step 12 freezes the results and is run by the orchestrator, which owns
// both results.

import type { Sleeper } from '../record-contract/primitives.ts';
import type { CleanupMode } from '../record-contract/records/group-b/vocabulary.ts';
import type { CleanupResource } from '../record-contract/records/group-c/cleanup_result.ts';
import type { LeakAuditResult } from '../record-contract/records/group-c/leak_audit_result.ts';
import type { CleanupFold } from './cleanup-action-fold.ts';
import type {
  BarrierReleasePort,
  CleanupEvidencePort,
  ConsumerControlPort,
  DlqMessagePort,
  DurableExecutionPort,
  ResourceDeleter,
  StackApi,
} from './cleanup-ports.ts';
import type { CleanupStepNumber } from './cleanup-steps.ts';
import { disableConsumers } from './consumer-shutdown.ts';
import type { DiscoverySurfaces } from './discovery.ts';
import { captureDlqEvidence, deleteCapturedDlqMessages } from './dlq-cleanup.ts';
import { recordInducedTransitions, releaseBarriersAndStopExecutions } from './execution-quiescing.ts';
import { deleteOwnedResources } from './owned-resource-deletion.ts';
import type { OwnershipContext } from './ownership-context.ts';
import type { ItemRecorder, StepOutcome } from './step-recording.ts';
import { outcomeFromFailures } from './step-recording.ts';

/** The run-owned things cleanup acts on besides what discovery finds. */
export interface CleanupTargets {
  /** Event-source mappings of both sources and the stream (step 3). */
  readonly event_source_mapping_ids: readonly string[];
  /** Control-table partitions that may hold a treatment barrier (step 5). */
  readonly treatment_partitions: readonly string[];
  /** Functions whose RUNNING durable executions are stopped before stack deletion (step 5, RK-10). */
  readonly durable_function_names: readonly string[];
}

/** The ports steps 1-11 act through. */
export interface StepPorts {
  readonly evidence: CleanupEvidencePort;
  readonly consumers: ConsumerControlPort;
  readonly barriers: BarrierReleasePort;
  readonly durableExecutions: DurableExecutionPort;
  readonly dlq: DlqMessagePort;
  readonly stacks: StackApi;
  readonly surfaces: DiscoverySurfaces;
  readonly deleter: ResourceDeleter;
  readonly sleeper: Sleeper;
}

/** Everything one step needs to run. */
export interface StepContext {
  readonly mode: CleanupMode;
  readonly ports: StepPorts;
  readonly targets: CleanupTargets;
  readonly ownership: OwnershipContext;
  /** The actions of every run so far, folded. */
  readonly fold: CleanupFold;
  /** Runs the leak audit (step 10) and keeps its result for steps 11 and 12. */
  readonly audit: () => Promise<LeakAuditResult>;
  /** The audit step 10 produced in this run (a pass-less `inconclusive` one before it), read by step 11. */
  readonly latestAudit: () => LeakAuditResult;
}

/**
 * Runs one of steps 1-11 and returns its outcome.
 *
 * @example
 * const outcome = await runCleanupStep(9, context, record); // deletes owned resources
 */
export async function runCleanupStep(
  step: Exclude<CleanupStepNumber, 12>,
  context: StepContext,
  record: ItemRecorder,
): Promise<StepOutcome> {
  const { mode, ports } = context;
  switch (step) {
    case 1:
      return ports.evidence.completeLateEvidenceCutoff(mode);
    case 2:
      return ports.evidence.freezeLateEvidenceAssessment(mode);
    case 3:
      return disableConsumers(context.targets.event_source_mapping_ids, ports.consumers, ports.sleeper, record);
    case 4:
      return ports.evidence.capturePreCleanupSnapshot(mode);
    case 5:
      return releaseBarriersAndStopExecutions(context.targets, ports, record);
    case 6:
      return recordInducedTransitions(context.fold, record);
    case 7:
      return captureDlqEvidence(mode, ports.evidence, record);
    case 8:
      return deleteCapturedDlqMessages(pendingDlqMessages(context.fold), ports.dlq, record);
    case 9:
      return deleteOwnedResources(context.ownership, ports, earlierDeleteFailures(context.fold), record);
    case 10:
      return auditOutcome(await context.audit());
    case 11:
      return stableAbsenceOutcome(context.latestAudit());
  }
}

// Captured messages no run has deleted or found gone yet (step 8 never touches uncaptured ones).
function pendingDlqMessages(fold: CleanupFold): readonly string[] {
  const settled = new Set([...fold.deleted_dlq_message_ids, ...fold.absent_dlq_message_ids]);
  return fold.captured_dlq_message_ids.filter((messageId) => !settled.has(messageId));
}

// Resources whose latest recorded deletion failed, in any run.
function earlierDeleteFailures(fold: CleanupFold): readonly CleanupResource[] {
  return fold.resources.filter((resource) => resource.action === 'DELETE_FAILED');
}

// Step 10 succeeds when every surface answered in every pass.
function auditOutcome(audit: LeakAuditResult): StepOutcome {
  const failedSurfaces = [
    ...new Set(audit.passes.flatMap((pass) => pass.surfaces.filter((s) => !s.query_ok).map((s) => s.surface))),
  ];
  if (audit.passes.length > 0 && failedSurfaces.length === 0) {
    return outcomeFromFailures([]);
  }
  const observed = audit.passes.length === 0 ? 'no audit pass' : `failed queries on ${failedSurfaces.join(', ')}`;
  return outcomeFromFailures([
    { code: 'LEAK_AUDIT_QUERY_FAILED', subject: 'leak-audit', detail: `${observed}; expected every surface to answer` },
  ]);
}

// Step 11 succeeds only on proven stable absence: a clean audit.
function stableAbsenceOutcome(audit: LeakAuditResult): StepOutcome {
  const status = audit.leak_audit_status;
  if (status === 'clean') {
    return outcomeFromFailures([]);
  }
  return outcomeFromFailures([
    {
      code: 'STABLE_ABSENCE_NOT_PROVEN',
      subject: 'leak-audit',
      detail: `leak audit status ${status} after ${String(audit.stable_absence_interval_ms)} ms between passes; expected clean`,
    },
  ]);
}
