// The frozen execution manifest of a package operand (design §7 `admission/execution-manifest.json`,
// BR-RUA-040): every command that acts on an admitted execution reads these exact bytes back, so
// it acts on the identity, digest and declarations admission froze and on nothing else. The bytes
// are read through the evidence file system and judged by the lifecycle's total reader (A-05); the
// manifest must also name the execution the package directory names.

import { readAdmittedExecution } from '../execution-lifecycle/admitted-execution.ts';
import type { AdmittedExecution } from '../execution-lifecycle/execution-ports.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT, executionIdOf } from '../evidence-package/package-layout.ts';
import { err } from '../record-contract/primitives.ts';
import type { ExecutionIdentity, Result, StructuredReason } from '../record-contract/primitives.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';

/**
 * The admitted execution of the package directory `identity` names.
 *
 * @example
 * const admitted = await readPackageManifest(files, { execution_kind: 'RUN', run_id }, validator);
 * if (admitted.ok) admitted.value.manifest.source.commit_sha;
 */
export async function readPackageManifest(
  files: PackageFileSystem,
  identity: ExecutionIdentity,
  validator: RecordValidator,
): Promise<Result<AdmittedExecution, StructuredReason>> {
  const path = `${PACKAGE_LAYOUT.executionDirectory(identity)}/${EXECUTION_PATHS.executionManifest}`;
  const bytes = await files.read(path);
  if (!bytes.ok) {
    return err(manifestReason(path, `${bytes.error.code}: ${bytes.error.detail}`));
  }
  const admitted = readAdmittedExecution(bytes.value, validator);
  if (!admitted.ok) {
    return admitted;
  }
  const declared = admitted.value.identity;
  if (declared.execution_kind !== identity.execution_kind || executionIdOf(declared) !== executionIdOf(identity)) {
    return err(
      manifestReason(
        path,
        `the manifest declares ${declared.execution_kind} ${executionIdOf(declared)}, not the package's ${identity.execution_kind} ${executionIdOf(identity)}`,
      ),
    );
  }
  return admitted;
}

function manifestReason(path: string, problem: string): StructuredReason {
  return {
    code: 'EXECUTION_MANIFEST_UNREADABLE',
    subject: 'BR-RUA-040',
    detail: `${path}: ${problem}; expected the package's frozen execution manifest`,
  };
}
