// Catalogue group B row 59 (design §6.2): the conditional capture of dead-letter messages,
// received without deletion (BR-RUA-032, BR-RUA-037, BR-RUA-048 step 7).

import type { Sha256Hex, UtcMillis } from '../../primitives.ts';
import type { ExecutionCorrelation, TrialScoped } from './shared-shapes.ts';

/** One captured message with its exact body and SQS attributes in snake_case. */
export interface DlqMessage {
  readonly message_id: string;
  readonly body: string;
  readonly body_sha256: Sha256Hex;
  readonly md5_of_body: string;
  readonly approximate_receive_count: number;
  /** Epoch milliseconds as SQS reports them, a digit string. */
  readonly approximate_first_receive_timestamp: string;
  readonly sent_timestamp: string;
  readonly message_group_id: string;
  readonly message_deduplication_id: string;
  readonly sequence_number: string;
}

interface DlqSnapshotFields extends TrialScoped {
  readonly schema_version: 1;
  readonly record_type: 'dlq_snapshot';
  readonly queue_name: string;
  readonly captured_at: UtcMillis;
  /** True when the capture drained every visible message of the queue. */
  readonly receive_complete: boolean;
  readonly messages: readonly DlqMessage[];
}

/** Schema: `schemas/group-b/dlq_snapshot.schema.json`. */
export type DlqSnapshot = ExecutionCorrelation & DlqSnapshotFields;
