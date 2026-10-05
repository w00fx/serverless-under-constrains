// Catalogue group B row 40 (design §6.2): an exact duplicate delivery of the signalled caller
// event, recorded as a diagnostic (BR-RUA-025).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';
import type { SignalledTreatmentState } from './vocabulary.ts';

/** Schema: `schemas/group-b/timeout_signal_duplicate_observed.schema.json`. */
export interface TimeoutSignalDuplicateObserved extends EventEnvelope<'timeout_signal_duplicate_observed'> {
  readonly source: 'treatment_controller';
  readonly caller_timeout_event_id: Uuid4;
  readonly attempt_id: Uuid4;
  readonly treatment_state: SignalledTreatmentState;
}
