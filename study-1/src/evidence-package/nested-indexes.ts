// The digests a package records about itself below the final index (design §8.16 step 2, "every
// indexed byte"): each evidence index must still match the files it froze, the probe's prefix
// checkpoint must still be a prefix of the complete coordination journal (BR-RUA-044), and the
// deployment-assembly inventory must still describe the assembly copy byte for byte (BR-RUA-042).
// A final index rebuilt after an edit would match the edited bytes; these older digests would not,
// so any mismatch is `ALTERED_BYTES`.

import { boundedJsonText } from '../record-contract/json-value.ts';
import type { PackageIneligibilityReason } from '../record-contract/records/group-c/package_verification.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { classifyPackageArtifact } from './artifact-classification.ts';
import { compareCodePoints, inventoryDigest } from './assembly-inventory.ts';
import { fileAt } from './index-entries.ts';
import { alteredEntryReason, ineligibility } from './package-integrity.ts';
import type { ByteDigest } from './package-integrity.ts';
import type { PackageFile } from './package-file-system.ts';
import { EXECUTION_DIRECTORIES, EXECUTION_PATHS } from './package-layout.ts';
import { parsePackageRecord } from './package-records.ts';
import { checkPrefixCheckpoint } from './prefix-checkpoint.ts';

/** The services the nested checks read with. */
export interface NestedIndexDeps {
  readonly validator: RecordValidator;
  readonly digest: ByteDigest;
}

const ASSEMBLY_PATH = EXECUTION_DIRECTORIES.deploymentAssembly.slice(0, -1);

/**
 * Every `ALTERED_BYTES` reason the evidence indexes, the prefix checkpoint and the assembly
 * inventory inside a package give against its stored files.
 *
 * @example
 * nestedIndexReasons(snapshot.files, { validator, digest: sha256Hex }); // [] for an intact package
 */
export function nestedIndexReasons(
  files: readonly PackageFile[],
  deps: NestedIndexDeps,
): readonly PackageIneligibilityReason[] {
  return [
    ...files.filter(isEvidenceIndex).flatMap((file) => evidenceIndexReasons(file, files, deps)),
    ...prefixCheckpointReasons(files, deps),
    ...inventoryReasons(files, deps),
  ];
}

function isEvidenceIndex(file: PackageFile): boolean {
  const classified = classifyPackageArtifact(file.path);
  return classified.ok && classified.value.artifact_class === 'evidence_index';
}

function evidenceIndexReasons(
  file: PackageFile,
  files: readonly PackageFile[],
  deps: NestedIndexDeps,
): readonly PackageIneligibilityReason[] {
  const index = parsePackageRecord(file.bytes, 'evidence_index', deps.validator, file.path);
  if (!index.ok) {
    return [unreadable(file.path, index.error.detail)];
  }
  return index.value.entries.flatMap((entry) =>
    alteredEntryReason('', entry, fileAt(files, entry.artifact_path), deps.digest).map((reason) => ({
      ...reason,
      detail: `evidence index ${boundedJsonText(file.path)}: ${reason.detail}`,
    })),
  );
}

function prefixCheckpointReasons(
  files: readonly PackageFile[],
  deps: NestedIndexDeps,
): readonly PackageIneligibilityReason[] {
  const path = EXECUTION_PATHS.coordinationPrefixCheckpoint;
  const file = fileAt(files, path);
  if (file === undefined) {
    return [];
  }
  const checkpoint = parsePackageRecord(file.bytes, 'coordination_prefix_checkpoint', deps.validator, path);
  if (!checkpoint.ok) {
    return [unreadable(path, checkpoint.error.detail)];
  }
  const journalPath = checkpoint.value.journal_path;
  const journal = fileAt(files, journalPath);
  if (journal === undefined) {
    return [
      ineligibility(
        'ALTERED_BYTES',
        `checkpointed journal ${boundedJsonText(journalPath)} is absent; expected the complete journal`,
        '',
        journalPath,
      ),
    ];
  }
  const problem = checkPrefixCheckpoint(checkpoint.value, journal.bytes);
  return problem === undefined
    ? []
    : [ineligibility('ALTERED_BYTES', `${boundedJsonText(journalPath)}: ${problem}`, '', journalPath)];
}

function inventoryReasons(files: readonly PackageFile[], deps: NestedIndexDeps): readonly PackageIneligibilityReason[] {
  const path = EXECUTION_PATHS.deploymentAssemblyInventory;
  const file = fileAt(files, path);
  if (file === undefined) {
    return [];
  }
  const inventory = parsePackageRecord(file.bytes, 'deployment_assembly_inventory', deps.validator, path);
  if (!inventory.ok) {
    return [unreadable(path, inventory.error.detail)];
  }
  const { assembly_path: assemblyPath, files: listed, inventory_sha256: recorded } = inventory.value;
  if (assemblyPath !== ASSEMBLY_PATH) {
    return [
      unreadable(path, `assembly_path is ${boundedJsonText(assemblyPath)}; expected ${boundedJsonText(ASSEMBLY_PATH)}`),
    ];
  }
  const recomputed = inventoryDigest(listed);
  const digestReasons =
    recomputed === recorded
      ? []
      : [unreadable(path, `inventory_sha256 is ${recorded}; expected ${recomputed}, the digest of its files`)];
  const orderReasons = inventoryOrderReasons(path, listed);
  const fileReasons = listed.flatMap((entry) => {
    const packagePath = `${assemblyPath}/${entry.path}`;
    const stored = { artifact_path: packagePath, bytes: entry.bytes, sha256: entry.sha256 };
    return alteredEntryReason('', stored, fileAt(files, packagePath), deps.digest);
  });
  const inventoried = new Set(listed.map((entry) => `${assemblyPath}/${entry.path}`));
  const extraReasons = files
    .filter(
      (stored) => stored.path.startsWith(EXECUTION_DIRECTORIES.deploymentAssembly) && !inventoried.has(stored.path),
    )
    .map((stored) =>
      ineligibility(
        'ALTERED_BYTES',
        `${boundedJsonText(stored.path)} is not in the deployment-assembly inventory; expected the frozen assembly only`,
        '',
        stored.path,
      ),
    );
  return [...digestReasons, ...orderReasons, ...fileReasons, ...extraReasons];
}

// The canonical inventory lists each path once, in strictly ascending code-point order (spec
// design "The canonical inventory sorts normalized relative paths"; the inventory schema leaves
// path uniqueness and order to this verifier). A recomputed digest cannot catch a reordered or
// duplicated list, because the digest covers the list as written.
function inventoryOrderReasons(
  path: string,
  listed: readonly { readonly path: string }[],
): readonly PackageIneligibilityReason[] {
  const reasons: PackageIneligibilityReason[] = [];
  let previous: string | undefined;
  for (const [index, entry] of listed.entries()) {
    if (previous !== undefined && compareCodePoints(previous, entry.path) >= 0) {
      const order = 'expected each path once, in strictly ascending code-point order';
      const found = `files[${String(index)}].path ${boundedJsonText(entry.path)} follows ${boundedJsonText(previous)}`;
      reasons.push(unreadable(path, `${found}; ${order}`));
    }
    previous = entry.path;
  }
  return reasons;
}

function unreadable(path: string, detail: string): PackageIneligibilityReason {
  return ineligibility(
    'ALTERED_BYTES',
    `${boundedJsonText(path)} cannot vouch for the bytes it froze: ${detail}`,
    '',
    path,
  );
}
