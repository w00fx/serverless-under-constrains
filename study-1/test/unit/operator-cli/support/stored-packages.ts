// Stores committed golden packages in a memory evidence file system the way the operator's evidence
// root holds them (`<kind-dir>/<execution_id>/…` and `amendments/<execution_id>/<dir>/…`), so the
// package commands read them back through the same port they use in production. The fixtures are
// the golden builders of the features that own each package kind.

import assert from 'node:assert/strict';

import type { PackageFile } from '../../../../src/evidence-package/package-file-system.ts';
import { PACKAGE_LAYOUT } from '../../../../src/evidence-package/package-layout.ts';
import type { ExecutionIdentity } from '../../../../src/record-contract/primitives.ts';
import { MemoryPackageFileSystem } from '../../../support/evidence-package/memory-package-file-system.ts';

/** The evidence root every stored package lives under in these tests. */
export const STORED_EVIDENCE_ROOT = '/operator/evidence';

/** An amendment directory to store beside the package. */
export interface StoredAmendment {
  readonly snapshot: { readonly directory: string; readonly files: readonly PackageFile[] };
}

/**
 * Writes the package files and its amendments once into `fs` (a new one by default).
 *
 * @example
 * const fs = await storePackage(PROBE_IDENTITY, built.files);
 */
export async function storePackage(
  identity: ExecutionIdentity,
  files: readonly PackageFile[] | ReadonlyMap<string, Uint8Array>,
  amendments: readonly StoredAmendment[] = [],
  fs: MemoryPackageFileSystem = new MemoryPackageFileSystem(),
): Promise<MemoryPackageFileSystem> {
  const directory = PACKAGE_LAYOUT.executionDirectory(identity);
  const entries: readonly PackageFile[] = isFileMap(files)
    ? [...files].map(([path, bytes]) => ({ path, bytes }))
    : files;
  for (const file of entries) {
    assert.equal((await fs.writeOnce(`${directory}/${file.path}`, file.bytes)).ok, true, file.path);
  }
  for (const { snapshot } of amendments) {
    const root = `${PACKAGE_LAYOUT.amendmentsDirectory(identity)}/${snapshot.directory}`;
    for (const file of snapshot.files) {
      assert.equal((await fs.writeOnce(`${root}/${file.path}`, file.bytes)).ok, true, file.path);
    }
  }
  return fs;
}

function isFileMap(
  files: readonly PackageFile[] | ReadonlyMap<string, Uint8Array>,
): files is ReadonlyMap<string, Uint8Array> {
  return files instanceof Map;
}

/**
 * The package operand of a stored execution.
 *
 * @example
 * packageOperand(PROBE_IDENTITY); // '/operator/evidence/transport-probes/<id>'
 */
export function packageOperand(identity: ExecutionIdentity): string {
  return `${STORED_EVIDENCE_ROOT}/${PACKAGE_LAYOUT.executionDirectory(identity)}`;
}
