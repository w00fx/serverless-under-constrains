// Catalogue group B row 30 (design §6.2): a call failed an acceptance check; no transaction,
// no treatment consumed (BR-RUA-018, AC-RUA-042).

import type { EventEnvelope } from '../../envelope.ts';
import type { Uuid4 } from '../../primitives.ts';
import type { ProviderRejectionReason } from './vocabulary.ts';

/** Schema: `schemas/group-b/provider_call_rejected.schema.json`. */
export interface ProviderCallRejected extends EventEnvelope<'provider_call_rejected'> {
  readonly source: 'refund_provider';
  readonly provider_call_id: Uuid4;
  readonly reason: ProviderRejectionReason;
  readonly detail: string;
}
