// Catalogue group B row 38 (design §6.2): an untargeted accepted call committed and returned
// SUCCEEDED (BR-RUA-025, BR-RUA-032).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';
import type { CommitTriple } from './shared-shapes.ts';

/** Schema: `schemas/group-b/provider_response_returned.schema.json`. */
export interface ProviderResponseReturned extends EventEnvelope<'provider_response_returned'>, CommitTriple {
  readonly source: 'refund_provider';
  readonly attempt_id: Uuid4;
  readonly provider_request_id: Uuid4;
}
