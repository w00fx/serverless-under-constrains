// The verified temporary deploy copy (design §9.8 D1; D-25; BR-RUA-042 "deploys only from that
// exact copy"; RK-13). The package keeps the frozen assembly and is never handed to `cdk deploy`,
// whose lock files would land in evidence. Instead:
// 1. the frozen inventory must match its own digest;
// 2. the temporary directory must be absent or empty, so no stale file rides along;
// 3. exactly the inventoried files are copied from the frozen directory, with their current
//    permission bits, and nothing is followed out of it;
// 4. the copy is re-inventoried and must equal the frozen inventory file by file.
// Only then is the copy a `VerifiedDeployCopy`; any failure is a list of reasons, and an
// unverified copy is never deployed (provisioning records PROVISIONING_FAILED).

import { join } from 'node:path';

import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { DeploymentAssemblyInventory } from '../record-contract/records/group-a/deployment_assembly_inventory.ts';
import { invalidPathReason } from '../evidence-package/artifact-classification.ts';
import type { FsEntry } from '../evidence-package/package-file-system.ts';
import type { AssemblyFileSystem } from './assembly-file-system.ts';
import { readAssemblyListing } from './assembly-listing.ts';
import type { VerifiedDeployCopy } from './assembly-ports.ts';
import { inventorySelfCheck, verifyAssemblyUnchanged } from './assembly-verification.ts';
import { deploymentReason } from './deployment-reasons.ts';

const PERMISSION_BITS = 0o7777;

/**
 * Copies the frozen assembly into `tempRoot` and proves the copy equal to `inventory`.
 *
 * @example
 * const copy = await prepareVerifiedDeployCopy(packageAssemblyDir, inventory, '/study-1/.deploy-staging/<id>', files);
 * if (copy.ok) await deployer.deploy(copy.value, stackName, outputsFile);
 */
export async function prepareVerifiedDeployCopy(
  frozenDir: string,
  inventory: DeploymentAssemblyInventory,
  tempRoot: string,
  files: AssemblyFileSystem,
): Promise<Result<VerifiedDeployCopy, readonly StructuredReason[]>> {
  const selfCheck = inventorySelfCheck(inventory);
  if (selfCheck !== undefined) {
    return err([selfCheck]);
  }
  const target = await emptyTargetReason(files, tempRoot);
  if (target !== undefined) {
    return err([target]);
  }
  const copied = await copyInventoriedFiles(frozenDir, inventory, tempRoot, files);
  if (copied !== undefined) {
    return err([copied]);
  }
  const listing = await readAssemblyListing(files, tempRoot);
  if (!listing.ok) {
    return listing;
  }
  const differences = verifyAssemblyUnchanged(inventory, listing.value);
  if (differences.length > 0) {
    return err([
      deploymentReason(
        'DEPLOY_COPY_NOT_VERIFIED',
        'BR-RUA-042',
        `the copy in ${boundedJsonText(tempRoot)} differs from inventory ${inventory.inventory_sha256}; expected a byte-identical copy`,
      ),
      ...differences,
    ]);
  }
  const copy = { dir: tempRoot, inventory_sha256: inventory.inventory_sha256 } as VerifiedDeployCopy;
  return ok(copy);
}

async function emptyTargetReason(files: AssemblyFileSystem, tempRoot: string): Promise<StructuredReason | undefined> {
  const listed = await files.list(tempRoot);
  if (!listed.ok && listed.error.code === 'NOT_FOUND') {
    return undefined;
  }
  if (!listed.ok) {
    return copyReason('DEPLOY_COPY_UNREADABLE', `${listed.error.code}: ${listed.error.detail}`);
  }
  if (listed.value.length === 0) {
    return undefined;
  }
  return copyReason(
    'DEPLOY_COPY_NOT_EMPTY',
    `${boundedJsonText(tempRoot)} already holds ${String(listed.value.length)} entries; expected an absent or empty directory`,
  );
}

async function copyInventoriedFiles(
  frozenDir: string,
  inventory: DeploymentAssemblyInventory,
  tempRoot: string,
  files: AssemblyFileSystem,
): Promise<StructuredReason | undefined> {
  const source = await files.list(frozenDir);
  if (!source.ok) {
    return copyReason('FROZEN_ASSEMBLY_UNREADABLE', `${source.error.code}: ${source.error.detail}`);
  }
  const sourceEntries = new Map(source.value.map((entry) => [entry.path, entry]));
  for (const file of inventory.files) {
    const problem = await copyOneFile(file.path, sourceEntries.get(file.path), frozenDir, tempRoot, files);
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
}

async function copyOneFile(
  path: string,
  entry: FsEntry | undefined,
  frozenDir: string,
  tempRoot: string,
  files: AssemblyFileSystem,
): Promise<StructuredReason | undefined> {
  const invalid = invalidPathReason(path);
  if (invalid !== undefined) {
    return copyReason('INVENTORY_PATH_INVALID', invalid.detail);
  }
  if (entry?.type !== 'file') {
    return copyReason(
      'FROZEN_FILE_MISSING',
      `${boundedJsonText(path)} is ${entry === undefined ? 'absent' : `a ${entry.type}`} in the frozen assembly; expected a regular file`,
    );
  }
  const bytes = await files.read(join(frozenDir, path));
  if (!bytes.ok) {
    return copyReason('FROZEN_ASSEMBLY_UNREADABLE', `${bytes.error.code}: ${bytes.error.detail}`);
  }
  const written = await files.createFile(join(tempRoot, path), bytes.value, entry.mode & PERMISSION_BITS);
  return written.ok
    ? undefined
    : copyReason('DEPLOY_COPY_WRITE_FAILED', `${written.error.code}: ${written.error.detail}`);
}

function copyReason(code: string, detail: string): StructuredReason {
  return deploymentReason(code, 'BR-RUA-042', detail);
}
