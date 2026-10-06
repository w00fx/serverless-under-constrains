// Proof that an assembly directory still is the frozen assembly (BR-RUA-042; design §9.8 D1, D3;
// D-25). The directory is re-inventoried with the same canonical inventory admission froze, and
// compared with it path by path: a file added (a CLI lock file, RK-13), removed or changed (bytes,
// mode or digest) is one reason each. A frozen inventory whose digest does not match its own file
// list proves nothing, so it is refused first. The listed differences are capped so that a
// directory flooded with files still yields a bounded reason list (A-12).

import { boundedJsonText } from '../record-contract/json-value.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type {
  AssemblyFileEntry,
  DeploymentAssemblyInventory,
} from '../record-contract/records/group-a/deployment_assembly_inventory.ts';
import { inventoryAssembly, inventoryDigest } from '../evidence-package/assembly-inventory.ts';
import type { AssemblyListing } from './assembly-listing.ts';
import { deploymentReason } from './deployment-reasons.ts';

/** At most this many differences are listed one by one; the rest are counted in one reason. */
export const MAX_LISTED_DIFFERENCES = 20;

/**
 * Every reason `listing` is not the frozen assembly `inventory` describes; empty when it is.
 *
 * @example
 * const listing = await readAssemblyListing(files, packageAssemblyDir);
 * if (listing.ok && verifyAssemblyUnchanged(inventory, listing.value).length === 0) record('PACKAGE_ASSEMBLY_REVERIFIED');
 */
export function verifyAssemblyUnchanged(
  inventory: DeploymentAssemblyInventory,
  listing: AssemblyListing,
): readonly StructuredReason[] {
  const selfCheck = inventorySelfCheck(inventory);
  if (selfCheck !== undefined) {
    return [selfCheck];
  }
  const current = inventoryAssembly({
    assembly_path: inventory.assembly_path,
    entries: listing.entries,
    files: listing.files,
    inventoried_at: inventory.inventoried_at,
  });
  if (!current.ok) {
    return current.error;
  }
  return capped(inventoryDifferences(inventory.files, current.value.files));
}

/**
 * The reason an inventory's digest does not match its own file list, or `undefined`.
 *
 * @example
 * inventorySelfCheck(inventory); // undefined for an intact inventory
 */
export function inventorySelfCheck(inventory: DeploymentAssemblyInventory): StructuredReason | undefined {
  const digest = inventoryDigest(inventory.files);
  if (digest === inventory.inventory_sha256) {
    return undefined;
  }
  return deploymentReason(
    'INVENTORY_DIGEST_MISMATCH',
    'BR-RUA-042',
    `inventory_sha256 ${boundedJsonText(inventory.inventory_sha256)} differs from the digest ${digest} of its files; expected an intact frozen inventory`,
  );
}

/**
 * The added, removed and changed files between two inventories' file lists, in path order.
 *
 * @example
 * inventoryDifferences(frozen.files, current.files); // [{ code: 'FILE_ADDED', ... 'read.1.1.lock' ... }]
 */
export function inventoryDifferences(
  expected: readonly AssemblyFileEntry[],
  actual: readonly AssemblyFileEntry[],
): readonly StructuredReason[] {
  const actualByPath = new Map(actual.map((file) => [file.path, file]));
  const expectedPaths = new Set(expected.map((file) => file.path));
  const removedOrChanged = expected.flatMap((file) => fileDifference(file, actualByPath.get(file.path)));
  const added = actual
    .filter((file) => !expectedPaths.has(file.path))
    .map((file) =>
      deploymentReason(
        'FILE_ADDED',
        'BR-RUA-042',
        `${boundedJsonText(file.path)} is not in the frozen inventory; expected no file beyond it`,
      ),
    );
  return [...removedOrChanged, ...added];
}

function fileDifference(expected: AssemblyFileEntry, actual: AssemblyFileEntry | undefined): StructuredReason[] {
  if (actual === undefined) {
    return [
      deploymentReason(
        'FILE_REMOVED',
        'BR-RUA-042',
        `${boundedJsonText(expected.path)} is missing; expected the frozen file of ${String(expected.bytes)} bytes`,
      ),
    ];
  }
  const changed = (['bytes', 'mode', 'sha256'] as const).filter((field) => expected[field] !== actual[field]);
  if (changed.length === 0) {
    return [];
  }
  const shown = changed.map((field) => `${field} ${String(actual[field])} (frozen ${String(expected[field])})`);
  return [
    deploymentReason(
      'FILE_CHANGED',
      'BR-RUA-042',
      `${boundedJsonText(expected.path)} has ${shown.join(', ')}; expected the frozen bytes, mode and digest`,
    ),
  ];
}

function capped(reasons: readonly StructuredReason[]): readonly StructuredReason[] {
  if (reasons.length <= MAX_LISTED_DIFFERENCES) {
    return reasons;
  }
  const hidden = reasons.length - MAX_LISTED_DIFFERENCES;
  return [
    ...reasons.slice(0, MAX_LISTED_DIFFERENCES),
    deploymentReason(
      'MORE_DIFFERENCES',
      'BR-RUA-042',
      `${String(hidden)} further difference(s) are not listed; expected no difference from the frozen inventory`,
    ),
  ];
}
