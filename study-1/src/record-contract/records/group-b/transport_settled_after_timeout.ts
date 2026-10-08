// Catalogue group B row 25 (design §6.2): a transport settlement observed after the timer
// won; the payload is never parsed (BR-RUA-015, BR-RUA-023, D-26).

import type { EventEnvelope } from '../../envelope.ts';
import type { DecimalString } from '../../primitives.ts';
import type { AttemptCorrelation } from './shared-shapes.ts';
import type { CallerEventSource, TransportSettlementKind } from './vocabulary.ts';

/** Schema: `schemas/group-b/transport_settled_after_timeout.schema.json`. */
export interface TransportSettledAfterTimeout
  extends EventEnvelope<'transport_settled_after_timeout'>, AttemptCorrelation {
  readonly source: CallerEventSource;
  readonly settlement_kind: TransportSettlementKind;
  readonly observed_after_elapsed_ns: DecimalString;
}
