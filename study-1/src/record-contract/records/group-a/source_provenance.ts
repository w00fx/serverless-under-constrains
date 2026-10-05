// `source_provenance` (BR-RUA-042): the clean committed source an admitted execution came from.
// A dirty tree never produces this record; it produces an admission rejection instead.

import type { Sha256Hex, UtcMillis, Uuid4 } from '../../primitives.ts';

/** Tool name (snake_case, for example `node` or `aws_cdk_cli`) to its exact version. */
export type ToolVersions = Readonly<Record<string, string>>;

/** A detached HEAD is acceptable and has no branch; an attached HEAD names its branch. */
export type HeadReference =
  | { readonly detached_head: true; readonly branch?: never }
  | { readonly detached_head: false; readonly branch: string };

export type SourceProvenance = HeadReference & {
  readonly schema_version: 1;
  readonly record_type: 'source_provenance';
  readonly admission_attempt_id: Uuid4;
  /** Git object id: SHA-1 (40 hex) or SHA-256 (64 hex). */
  readonly commit_sha: string;
  readonly tree_sha: string;
  readonly clean_confirmed: true;
  readonly lockfile_path: string;
  readonly lockfile_sha256: Sha256Hex;
  readonly tool_versions: ToolVersions;
  readonly recorded_at: UtcMillis;
};
