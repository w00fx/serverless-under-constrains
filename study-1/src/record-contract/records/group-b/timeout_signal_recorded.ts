// Catalogue group B row 39 (design §6.2): the controller signal, immediately caused by the
// provider commit event and the caller timeout event (BR-RUA-013, BR-RUA-025).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';

/** Schema: `schemas/group-b/timeout_signal_recorded.schema.json`. */
export interface TimeoutSignalRecorded extends EventEnvelope<'timeout_signal_recorded'> {
  readonly source: 'treatment_controller';
  /** Sorted `[provider commit event, caller timeout event]`. */
  readonly causation_event_ids: readonly Uuid4[];
  readonly provider_commit_id: Uuid4;
  readonly attempt_id: Uuid4;
  readonly caller_timeout_event_id: Uuid4;
  readonly provider_commit_event_id: Uuid4;
}
