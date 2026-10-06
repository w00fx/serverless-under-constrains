// Catalogue group B row 62 (design §6.2): every durable execution of the caller version
// started after publication, with its history (BR-RUA-037, BR-RUA-020).

import type { UtcMillis } from '../../primitives.ts';
import type { ExecutionCorrelation, TrialScoped } from './shared-shapes.ts';
import type { DurableExecutionStatus } from './vocabulary.ts';

/** One history event in the service spelling (`StepFailed`, `InvocationCompleted`, ...). */
export interface DurableHistoryEvent {
  /**
   * The service's integer history `EventId`, named apart from the study's UUIDv4 `event_id`
   * (BR-RUA-033) so a walker over `event_id` members never mistakes one for the other.
   */
  readonly history_event_id?: number;
  readonly event_type: string;
  readonly event_timestamp: UtcMillis;
  readonly name?: string;
  readonly current_attempt?: number;
  readonly next_attempt_delay_seconds?: number;
  readonly request_id?: string;
  readonly error_type?: string;
}

/** One durable execution and its paged history. */
export interface DurableExecutionRecord {
  readonly durable_execution_arn: string;
  readonly durable_execution_name: string;
  readonly status: DurableExecutionStatus;
  readonly started_at: UtcMillis;
  readonly ended_at?: UtcMillis;
  readonly version?: string;
  readonly history_complete: boolean;
  readonly history: readonly DurableHistoryEvent[];
}

interface DurableExecutionMetadataFields extends TrialScoped {
  readonly schema_version: 1;
  readonly record_type: 'durable_execution_metadata';
  readonly function_arn: string;
  readonly qualifier: string;
  readonly captured_at: UtcMillis;
  /** The `StartedAfter` bound of the listing: the trial publication time. */
  readonly started_after: UtcMillis;
  readonly list_complete: boolean;
  readonly executions: readonly DurableExecutionRecord[];
}

/** Schema: `schemas/group-b/durable_execution_metadata.schema.json`. */
export type DurableExecutionMetadata = ExecutionCorrelation & DurableExecutionMetadataFields;
