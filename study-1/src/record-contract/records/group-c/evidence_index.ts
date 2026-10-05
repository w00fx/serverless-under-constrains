// Catalogue group C row 68 (design §6.2, §7): the index that freezes one trial, or the probe,
// by hashing its files and the execution-level core files it depends on. It excludes itself
// and the late-evidence area (BR-RUA-043, BR-RUA-044, AC-RUA-010).

import type { Sha256Hex, Uuid4, UtcMillis } from '../../primitives.ts';
import type { ExecutionScoped, IndexEntry, TrialScoped } from './shared-shapes.ts';

interface EvidenceIndexFields {
  readonly schema_version: 1;
  readonly record_type: 'evidence_index';
  readonly execution_manifest_sha256: Sha256Hex;
  /** Sorted by `artifact_path`, unique paths (design §7). */
  readonly entries: readonly IndexEntry[];
  readonly created_at: UtcMillis;
}

/** `trials/<t>/evidence-index.json` of a run or variant validation. */
export type TrialEvidenceIndex = EvidenceIndexFields &
  TrialScoped & {
    readonly index_scope: 'TRIAL';
  } & ({ readonly run_id: Uuid4 } | { readonly variant_validation_id: Uuid4 });

/** `probe/evidence-index.json`: the probe has no trial (D-06). */
export type ProbeEvidenceIndex = EvidenceIndexFields &
  ExecutionScoped & {
    readonly index_scope: 'PROBE';
    readonly transport_probe_id: Uuid4;
  };

/** Schema: `schemas/group-c/evidence_index.schema.json`. */
export type EvidenceIndex = TrialEvidenceIndex | ProbeEvidenceIndex;
