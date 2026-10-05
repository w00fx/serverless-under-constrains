// Catalogue group B row 35 (design §6.2): the provider barrier observed the controller signal
// (BR-RUA-013, BR-RUA-025).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';

/** Schema: `schemas/group-b/treatment_timeout_observed.schema.json`. */
export interface TreatmentTimeoutObserved extends EventEnvelope<'treatment_timeout_observed'> {
  readonly source: 'refund_provider';
  /** Names `timeout_signal_recorded`. */
  readonly causation_event_ids: readonly Uuid4[];
  readonly provider_commit_id: Uuid4;
  readonly provider_call_id: Uuid4;
  readonly attempt_id: Uuid4;
  readonly signal_event_id: Uuid4;
}
