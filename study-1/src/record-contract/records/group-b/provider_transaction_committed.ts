// Catalogue group B row 32 (design §6.2): written inside the commit transaction together with
// the ledger item and, when targeted, the treatment update (BR-RUA-025, D-23).

import type { EventEnvelope } from '../../envelope.ts';
import type { UtcMillis } from '../../primitives.ts';
import type { AttemptCorrelation, CommitTriple } from './shared-shapes.ts';

/** Schema: `schemas/group-b/provider_transaction_committed.schema.json`. */
export interface ProviderTransactionCommitted
  extends EventEnvelope<'provider_transaction_committed'>, AttemptCorrelation, CommitTriple {
  readonly source: 'refund_provider';
  readonly payment_id: string;
  readonly amount_minor: number;
  readonly currency: string;
  /** True only for the first accepted call of a COMMIT_THEN_TIMEOUT trial (BR-RUA-025). */
  readonly targeted: boolean;
  /** In-transaction wall time; diagnostic only, BR-RUA-010 decides on `committed_at` (D-24). */
  readonly commit_requested_at: UtcMillis;
}
