// Catalogue group B row 24 (design §6.2): the durable application timeout, and the only
// record the treatment controller consumes (BR-RUA-011, BR-RUA-023, BR-RUA-025).

import type { EventEnvelope } from '../../envelope.ts';
import type { DecimalString, Uuid4, UtcMillis } from '../../primitives.ts';
import type { AttemptCorrelation } from './shared-shapes.ts';
import type { ArbiterWinner, CallerEventSource } from './vocabulary.ts';

/**
 * Schema: `schemas/group-b/caller_timeout_recorded.schema.json`. A correct writer records
 * `arbiter_winner: 'TIMER'` and `transport_settled_at_claim: false`; the other values stay
 * representable so the oracle can fail BR-RUA-011 instead of rejecting the bytes. The runner
 * writes one into the canary partition (D-10).
 */
export interface CallerTimeoutRecorded extends EventEnvelope<'caller_timeout_recorded'>, AttemptCorrelation {
  readonly source: CallerEventSource | 'runner';
  /** Names the attempt's `dispatch_started`. */
  readonly causation_event_ids: readonly Uuid4[];
  readonly elapsed_ns: DecimalString;
  readonly monotonic_origin_event_id: Uuid4;
  readonly dispatch_at: UtcMillis;
  readonly deadline_at: UtcMillis;
  readonly timer_fired_at: UtcMillis;
  readonly abort_requested_at: UtcMillis;
  readonly recorded_at: UtcMillis;
  readonly arbiter_winner: ArbiterWinner;
  readonly transport_settled_at_claim: boolean;
}
