// Catalogue group B row 42 (design §6.2): a caller timeout arrived after the safety release
// (BR-RUA-025).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';

/** Schema: `schemas/group-b/late_timeout_signal_rejected.schema.json`. */
export interface LateTimeoutSignalRejected extends EventEnvelope<'late_timeout_signal_rejected'> {
  readonly source: 'treatment_controller';
  readonly caller_timeout_event_id: Uuid4;
  readonly attempt_id: Uuid4;
  readonly treatment_state: 'SAFETY_RELEASED';
}
