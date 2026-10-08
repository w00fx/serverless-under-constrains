// Catalogue group B row 33 (design §6.2): the post-acknowledgement commit time BR-RUA-010
// compares with the caller timer (D-24).

import type { EventEnvelope } from '../../envelope.ts';
import type { UtcMillis } from '../../primitives.ts';
import type { CommitTriple } from './shared-shapes.ts';

/** Schema: `schemas/group-b/provider_commit_confirmed.schema.json`. */
export interface ProviderCommitConfirmed extends EventEnvelope<'provider_commit_confirmed'>, CommitTriple {
  readonly source: 'refund_provider';
  readonly committed_at: UtcMillis;
}
