// The frozen `cleanup_result` (design §6.2 row 75, §10.4): a fold over every cleanup run's
// actions, so a re-run that skips a succeeded step still reports what that step did
// (AC-RUA-011). A captured DLQ message a later run found already gone counts as deleted, like any
// already-absent owned resource.

import { executionIdentityFields } from '../record-contract/envelope.ts';
import type { ExecutionIdentity, Sha256Hex, UtcMillis } from '../record-contract/primitives.ts';
import type { CleanupMode } from '../record-contract/records/group-b/vocabulary.ts';
import type { CleanupResult } from '../record-contract/records/group-c/cleanup_result.ts';
import type { CleanupFold } from './cleanup-action-fold.ts';
import { stepStatusOf } from './cleanup-action-fold.ts';
import { deriveCleanupStatus } from './operational-statuses.ts';

export interface CleanupResultInput {
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly cleanup_mode: CleanupMode;
  readonly fold: CleanupFold;
  /** When the first cleanup run of this execution started. */
  readonly started_at: UtcMillis;
  readonly completed_at: UtcMillis;
  readonly duration_breach: boolean;
}

/**
 * Builds the terminal `cleanup_result` record from the folded cleanup actions.
 *
 * @example
 * const result = buildCleanupResult({ execution, execution_manifest_sha256, cleanup_mode: 'NORMAL', fold, started_at, completed_at, duration_breach: false });
 * result.cleanup_status; // 'succeeded' when step 9 succeeded without a failed deletion
 */
export function buildCleanupResult(input: CleanupResultInput): CleanupResult {
  const { fold } = input;
  return {
    schema_version: 1,
    record_type: 'cleanup_result',
    ...executionIdentityFields(input.execution),
    execution_manifest_sha256: input.execution_manifest_sha256,
    cleanup_mode: input.cleanup_mode,
    cleanup_status: deriveCleanupStatus({ step9_status: stepStatusOf(fold, 9), resources: fold.resources }),
    steps: fold.steps,
    resources: fold.resources,
    stopped_durable_execution_arns: fold.stopped_durable_execution_arns,
    deleted_dlq_message_ids: [...new Set([...fold.deleted_dlq_message_ids, ...fold.absent_dlq_message_ids])].sort(),
    duration_breach: input.duration_breach,
    started_at: input.started_at,
    completed_at: input.completed_at,
  };
}
