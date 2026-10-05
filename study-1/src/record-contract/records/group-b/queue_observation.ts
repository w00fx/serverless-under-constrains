// Catalogue group B row 57 (design §6.2): one approximate counter read of a variant queue,
// a line of `queues/{source,dlq}-observations.jsonl` (BR-RUA-032, BR-RUA-037).

import type { UtcMillis } from '../../primitives.ts';
import type { ExecutionCorrelation, QueueCounters, TrialScoped } from './shared-shapes.ts';
import type { QueueRole } from './vocabulary.ts';

interface QueueObservationBase extends TrialScoped {
  readonly schema_version: 1;
  readonly record_type: 'queue_observation';
  readonly queue_role: QueueRole;
  readonly queue_name: string;
  readonly observed_at: UtcMillis;
}

/** The counters were read. */
export interface QueueCountersObserved extends QueueObservationBase {
  readonly read_status: 'ok';
  readonly counters: QueueCounters;
}

/** The read failed; an unavailable read is never quiet (design §8.12). */
export interface QueueCountersUnavailable extends QueueObservationBase {
  readonly read_status: 'unavailable';
  readonly error_code: string;
}

/** Schema: `schemas/group-b/queue_observation.schema.json`. */
export type QueueObservation = ExecutionCorrelation & (QueueCountersObserved | QueueCountersUnavailable);
