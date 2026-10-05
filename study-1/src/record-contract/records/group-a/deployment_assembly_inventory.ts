// `deployment_assembly_inventory` (BR-RUA-042): the canonical inventory of the frozen deployment
// assembly. Only regular files exist here: symlinks, special files and container-image assets
// are rejected before an inventory is built.

import type { Sha256Hex, UtcMillis } from '../../primitives.ts';

export interface AssemblyFileEntry {
  /** Normalized POSIX path relative to the assembly root. */
  readonly path: string;
  readonly bytes: number;
  /** Permission bits as four octal digits, for example `0644`. */
  readonly mode: string;
  readonly sha256: Sha256Hex;
}

export interface DeploymentAssemblyInventory {
  readonly schema_version: 1;
  readonly record_type: 'deployment_assembly_inventory';
  /** Package-relative directory of the frozen copy, for example `admission/deployment-assembly`. */
  readonly assembly_path: string;
  /** Sorted by path in code-point order; never empty. */
  readonly files: readonly [AssemblyFileEntry, ...AssemblyFileEntry[]];
  /** Digest of the canonical JSON of `files`. */
  readonly inventory_sha256: Sha256Hex;
  readonly inventoried_at: UtcMillis;
}
