// Catalogue group C row 75 (design §6.2, §10.4, §8.18): the frozen result of normal or
// emergency cleanup (BR-RUA-048, BR-RUA-049, BR-RUA-050, BR-RUA-051).

import type { StructuredReason, Sha256Hex, UtcMillis } from '../../primitives.ts';
import type { CleanupMode, OwnershipBasis, StepStatus } from '../group-b/vocabulary.ts';
import type { ExecutionCorrelation, ExecutionScoped } from './shared-shapes.ts';
import type { CleanupResourceAction, CleanupStatus } from './vocabulary.ts';

/** One of the twelve BR-RUA-048 steps. */
export interface CleanupStep {
  readonly step: number;
  readonly status: StepStatus;
  readonly started_at?: UtcMillis;
  readonly completed_at?: UtcMillis;
  readonly reasons: readonly StructuredReason[];
}

/** What cleanup did with one discovered resource and on which ownership basis. */
export interface CleanupResource {
  readonly resource_type: string;
  readonly resource_identifier: string;
  readonly ownership_basis: OwnershipBasis;
  readonly action: CleanupResourceAction;
  readonly reasons: readonly StructuredReason[];
}

interface CleanupResultFields extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'cleanup_result';
  readonly execution_manifest_sha256: Sha256Hex;
  readonly cleanup_mode: CleanupMode;
  readonly cleanup_status: CleanupStatus;
  readonly steps: readonly CleanupStep[];
  readonly resources: readonly CleanupResource[];
  /** Durable executions stopped before stack deletion (RK-10). */
  readonly stopped_durable_execution_arns: readonly string[];
  /** Captured run-owned DLQ messages deleted at step 8, never uncaptured ones. */
  readonly deleted_dlq_message_ids: readonly string[];
  /** True when cleanup continued past the total-time target (AC-RUA-049). */
  readonly duration_breach: boolean;
  readonly started_at: UtcMillis;
  readonly completed_at?: UtcMillis;
}

/** Schema: `schemas/group-c/cleanup_result.schema.json`. */
export type CleanupResult = ExecutionCorrelation & CleanupResultFields;
