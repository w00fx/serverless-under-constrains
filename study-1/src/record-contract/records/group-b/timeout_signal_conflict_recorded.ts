// Catalogue group B row 41 (design §6.2): another caller event attempted an existing signal's
// transition; conflicting control evidence (BR-RUA-025).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';
import type { SignalledTreatmentState } from './vocabulary.ts';

/** Schema: `schemas/group-b/timeout_signal_conflict_recorded.schema.json`. */
export interface TimeoutSignalConflictRecorded extends EventEnvelope<'timeout_signal_conflict_recorded'> {
  readonly source: 'treatment_controller';
  readonly caller_timeout_event_id: Uuid4;
  readonly existing_caller_event_id: Uuid4;
  readonly attempt_id: Uuid4;
  readonly treatment_state: SignalledTreatmentState;
}
