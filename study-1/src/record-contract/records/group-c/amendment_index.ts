// Catalogue group C row 84 (design §6.2, §7): `amendment-index.json`, written last in an
// immutable amendment package (BR-RUA-043). It references the original package and the
// preceding amendment; the verifier, not the schema, judges the chain (D-12).

import type { Sha256Hex, Uuid4, UtcMillis } from '../../primitives.ts';
import type { ExecutionCorrelation, IndexEntry } from './shared-shapes.ts';
import type { AmendmentKind } from './vocabulary.ts';

interface AmendmentIndexFields {
  readonly schema_version: 1;
  readonly record_type: 'amendment_index';
  readonly amendment_id: Uuid4;
  readonly amendment_kind: AmendmentKind;
  /** Dense from 1 per execution. */
  readonly sequence: number;
  readonly original_package_index_sha256: Sha256Hex;
  /** `null` for sequence 1: there is no preceding amendment (absence with meaning). */
  readonly parent_amendment_index_sha256: Sha256Hex | null;
  /** Every payload file, sorted by `artifact_path`. */
  readonly entries: readonly IndexEntry[];
  readonly created_at: UtcMillis;
}

/** Schema: `schemas/group-c/amendment_index.schema.json`. */
export type AmendmentIndex = ExecutionCorrelation & AmendmentIndexFields;
