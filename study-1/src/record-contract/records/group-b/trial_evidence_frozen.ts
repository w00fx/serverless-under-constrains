// Catalogue group B row 52 (design §6.2): the trial evidence index was written, freezing the
// trial (BR-RUA-043).

import type { EventEnvelope } from '../../envelope.ts';
import type { Sha256Hex } from '../../primitives.ts';

/** Schema: `schemas/group-b/trial_evidence_frozen.schema.json`. */
export interface TrialEvidenceFrozen extends EventEnvelope<'trial_evidence_frozen'> {
  readonly source: 'runner';
  /** Normalized package-relative POSIX path (BR-RUA-035). */
  readonly evidence_index_path: string;
  readonly evidence_index_sha256: Sha256Hex;
}
