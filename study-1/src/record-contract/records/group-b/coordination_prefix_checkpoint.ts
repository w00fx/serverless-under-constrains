// Catalogue group B row 65 (design §6.2): the prefix checkpoint of the coordination journal
// that a transport probe's evidence index hashes (BR-RUA-044).

import type { Sha256Hex, Uuid4, UtcMillis } from '../../primitives.ts';
import type { ExecutionScoped } from './shared-shapes.ts';

/** Schema: `schemas/group-b/coordination_prefix_checkpoint.schema.json` (probe packages only). */
export interface CoordinationPrefixCheckpoint extends ExecutionScoped {
  readonly schema_version: 1;
  readonly record_type: 'coordination_prefix_checkpoint';
  readonly transport_probe_id: Uuid4;
  readonly execution_manifest_sha256: Sha256Hex;
  /** Package-relative path of the coordination journal. */
  readonly journal_path: string;
  readonly prefix_byte_count: number;
  readonly prefix_sha256: Sha256Hex;
  readonly last_event_id: Uuid4;
  readonly last_source_sequence: number;
  readonly checkpointed_at: UtcMillis;
}
