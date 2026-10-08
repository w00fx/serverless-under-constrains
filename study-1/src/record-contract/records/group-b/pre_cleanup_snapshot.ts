// Catalogue group B row 64 (design §6.2): the operational state before cleanup mutates
// anything, best effort with every failed read recorded (BR-RUA-048 step 4).

import type { StructuredReason, UtcMillis } from '../../primitives.ts';
import type { ExecutionCorrelation, ExecutionScoped, QueueCounters } from './shared-shapes.ts';
import type { CleanupMode, DurableExecutionStatus, TreatmentState } from './vocabulary.ts';

/** A treatment item read: state and version only when the read succeeded. */
export type TreatmentRead =
  | {
      readonly partition_key: string;
      readonly read_status: 'ok';
      readonly state: TreatmentState;
      readonly version: number;
    }
  | { readonly partition_key: string; readonly read_status: 'absent' | 'unavailable' };

/** Provider activity derived for one partition (design §9.3). */
export interface ProviderActivityRead {
  readonly partition_key: string;
  readonly active_calls: number;
  readonly held_barriers: number;
  readonly pending_releases: number;
}

/** A durable execution that cleanup must stop before deleting the stack (RK-10). */
export interface DurableExecutionStatusRead {
  readonly durable_execution_arn: string;
  readonly status: DurableExecutionStatus;
}

/** A queue counter read: counters only when the read succeeded. */
export type QueueRead =
  | { readonly queue_name: string; readonly read_status: 'ok'; readonly counters: QueueCounters }
  | { readonly queue_name: string; readonly read_status: 'unavailable' };

interface PreCleanupSnapshotFields extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'pre_cleanup_snapshot';
  readonly captured_at: UtcMillis;
  readonly cleanup_mode: CleanupMode;
  readonly treatment_states: readonly TreatmentRead[];
  readonly provider_activity: readonly ProviderActivityRead[];
  readonly durable_executions: readonly DurableExecutionStatusRead[];
  readonly queues: readonly QueueRead[];
  readonly failures: readonly StructuredReason[];
}

/** Schema: `schemas/group-b/pre_cleanup_snapshot.schema.json`. */
export type PreCleanupSnapshot = ExecutionCorrelation & PreCleanupSnapshotFields;
