// The ports cleanup acts through (BR-RUA-048 steps 1-12, design §10.4). Every port reports
// failure as a value, never by throwing. The AWS bindings live in `aws/`; the evidence steps
// (late evidence, pre-cleanup snapshot, DLQ capture, final freeze) belong to the features that
// own those artifacts, and the composition root binds them.

import type { StructuredReason } from '../record-contract/primitives.ts';
import type { CleanupMode } from '../record-contract/records/group-b/vocabulary.ts';
import type { CleanupResult } from '../record-contract/records/group-c/cleanup_result.ts';
import type { LeakAuditResult } from '../record-contract/records/group-c/leak_audit_result.ts';
import type { DiscoveredResource } from './discovery.ts';

/** The terminal outcome of a step that another feature performs. */
export interface StepReport {
  readonly status: 'succeeded' | 'failed' | 'skipped';
  readonly reasons: readonly StructuredReason[];
}

/** Step 7: the run-owned DLQ messages captured as evidence (receive without delete). */
export interface DlqCaptureReport extends StepReport {
  readonly captured_message_ids: readonly string[];
}

/** What cleanup freezes at step 12. */
export interface CleanupResults {
  readonly cleanup_result: CleanupResult;
  readonly leak_audit_result: LeakAuditResult;
}

/** Steps 1, 2, 4, 7 and 12: evidence artifacts written by their owning features. */
export interface CleanupEvidencePort {
  /** Step 1: completes (normal) or shortens or skips (emergency) the late-evidence cutoff. */
  completeLateEvidenceCutoff(mode: CleanupMode): Promise<StepReport>;
  /** Step 2: freezes the late-evidence assessment (`unverified` when the cutoff was cut short). */
  freezeLateEvidenceAssessment(mode: CleanupMode): Promise<StepReport>;
  /** Step 4: captures `pre-cleanup-snapshot.json`, best effort, with failures recorded. */
  capturePreCleanupSnapshot(mode: CleanupMode): Promise<StepReport>;
  /** Step 7: captures correlated DLQ evidence not yet captured. */
  captureDlqEvidence(mode: CleanupMode): Promise<DlqCaptureReport>;
  /** Step 12: freezes the cleanup and leak-audit results with the summary and package index. */
  freezeResults(results: CleanupResults): Promise<StepReport>;
}

export type ConsumerDisableRequest =
  | { readonly kind: 'requested' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly reason: StructuredReason };

export type ConsumerStateRead =
  | { readonly kind: 'state'; readonly state: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly reason: StructuredReason };

/** Step 3: event-source mappings (`UpdateEventSourceMapping(Enabled=false)`, then `State`). */
export interface ConsumerControlPort {
  requestDisable(mappingId: string): Promise<ConsumerDisableRequest>;
  readState(mappingId: string): Promise<ConsumerStateRead>;
}

export type BarrierReleaseOutcome =
  | { readonly kind: 'released'; readonly from_state: string }
  | { readonly kind: 'not_held'; readonly state?: string }
  | { readonly kind: 'failed'; readonly reason: StructuredReason };

/** Step 5: the conditional safety-release request on a treatment item (design §9.3 `control`). */
export interface BarrierReleasePort {
  requestSafetyRelease(partitionKey: string): Promise<BarrierReleaseOutcome>;
}

export type DurableExecutionListing =
  | { readonly ok: true; readonly running_execution_arns: readonly string[] }
  | { readonly ok: false; readonly reason: StructuredReason };

export type DurableStopOutcome =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'not_running' }
  | { readonly kind: 'failed'; readonly reason: StructuredReason };

/** Step 5: running durable executions are stopped before stack deletion (RK-10). */
export interface DurableExecutionPort {
  listRunning(functionName: string): Promise<DurableExecutionListing>;
  stop(executionArn: string): Promise<DurableStopOutcome>;
}

export interface DlqDeletionReport {
  readonly deleted: readonly string[];
  readonly absent: readonly string[];
  readonly failed: readonly { readonly message_id: string; readonly reason: StructuredReason }[];
}

/** Step 8: deletes exactly the captured run-owned DLQ messages, never uncaptured ones. */
export interface DlqMessagePort {
  deleteCaptured(messageIds: readonly string[]): Promise<DlqDeletionReport>;
}

export type StackRead =
  | { readonly kind: 'present'; readonly status: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly reason: StructuredReason };

export type StackDeleteRequest =
  { readonly kind: 'requested' } | { readonly kind: 'failed'; readonly reason: StructuredReason };

/** Step 9: the recorded stack, deleted by its id as the ownership boundary (BR-RUA-050). */
export interface StackApi {
  describe(stackId: string): Promise<StackRead>;
  requestDelete(stackId: string): Promise<StackDeleteRequest>;
}

export type ResourceDeletion =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'already_absent' }
  | { readonly kind: 'failed'; readonly reason: StructuredReason };

/** Step 9: direct deletion of an owned resource that remains after stack deletion. */
export interface ResourceDeleter {
  delete(resource: DiscoveredResource): Promise<ResourceDeletion>;
}

/** The safety supervisor's view cleanup needs (BR-RUA-046, AC-RUA-049). */
export interface CleanupSafetyClock {
  totalTargetExceeded(): boolean;
}
