// Catalogue group B row 36 (design §6.2): the targeted response was released only after the
// observation (BR-RUA-014).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';

/** Schema: `schemas/group-b/treatment_response_released.schema.json`. */
export interface TreatmentResponseReleased extends EventEnvelope<'treatment_response_released'> {
  readonly source: 'refund_provider';
  /** Names `treatment_timeout_observed`. */
  readonly causation_event_ids: readonly Uuid4[];
  readonly provider_commit_id: Uuid4;
  readonly provider_call_id: Uuid4;
  readonly attempt_id: Uuid4;
}
