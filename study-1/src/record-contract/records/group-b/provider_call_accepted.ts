// Catalogue group B row 31 (design §6.2): a call passed every acceptance check
// (BR-RUA-018, BR-RUA-027 cardinality).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';
import type { AttemptCorrelation } from './shared-shapes.ts';
import type { CallerId } from './vocabulary.ts';

/** Schema: `schemas/group-b/provider_call_accepted.schema.json`. */
export interface ProviderCallAccepted extends EventEnvelope<'provider_call_accepted'>, AttemptCorrelation {
  readonly source: 'refund_provider';
  readonly provider_call_id: Uuid4;
  readonly caller_id: CallerId;
  readonly payment_id: string;
  readonly amount_minor: number;
  readonly currency: string;
}
