// Catalogue group C row 79 (design §6.2, §7): `package-index.json`, written last. It hashes
// every finalized package file except itself, late evidence and the full coordination journal
// included (BR-RUA-044).

import type { ExecutionKind, Sha256Hex, Uuid4, UtcMillis } from '../../primitives.ts';
import type { IndexEntry } from './shared-shapes.ts';

/** The package kind names the one execution identity the package carries. */
export type PackageIdentity =
  | { readonly execution_kind: Extract<ExecutionKind, 'RUN'>; readonly run_id: Uuid4 }
  | { readonly execution_kind: Extract<ExecutionKind, 'TRANSPORT_PROBE'>; readonly transport_probe_id: Uuid4 }
  | { readonly execution_kind: Extract<ExecutionKind, 'VARIANT_VALIDATION'>; readonly variant_validation_id: Uuid4 };

interface PackageIndexFields {
  readonly schema_version: 1;
  readonly record_type: 'package_index';
  readonly execution_manifest_sha256: Sha256Hex;
  /** Sorted by `artifact_path`, unique paths. */
  readonly entries: readonly IndexEntry[];
  readonly created_at: UtcMillis;
}

/** Schema: `schemas/group-c/package_index.schema.json`. */
export type PackageIndex = PackageIndexFields & PackageIdentity;
