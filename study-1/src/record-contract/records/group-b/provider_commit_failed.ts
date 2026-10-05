// Catalogue group B row 34 (design §6.2): the commit failed definitively and nothing was
// committed (BR-RUA-016, D-23).

import type { EventEnvelope } from '../../envelope.ts';
import type { CommitTriple } from './shared-shapes.ts';

/** Schema: `schemas/group-b/provider_commit_failed.schema.json`. */
export interface ProviderCommitFailed extends EventEnvelope<'provider_commit_failed'>, CommitTriple {
  readonly source: 'refund_provider';
  readonly targeted: boolean;
  /** The service error code of the definitive failure. */
  readonly error_code: string;
  readonly detail: string;
}
