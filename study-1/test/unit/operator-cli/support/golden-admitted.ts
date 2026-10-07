// The admitted executions the operator-cli unit tests act on: each golden execution read back from
// the exact execution manifest bytes admission froze (`frozenCoreFiles`), and the package files a
// command finds in the evidence root before any runner started (the admission files and the two
// frozen manifests, no runner journal).

import { readAdmittedExecution } from '../../../../src/execution-lifecycle/admitted-execution.ts';
import type { AdmittedExecution } from '../../../../src/execution-lifecycle/execution-ports.ts';
import type { PackageFile } from '../../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import type { GoldenExecution } from '../../../support/golden-builder/golden-plan.ts';
import { frozenCoreFiles } from '../../../support/offline-cloud/offline-execution.ts';

const validator = createRecordValidator();

/**
 * The admitted golden execution `name`.
 *
 * @example
 * goldenAdmitted('probe').identity.execution_kind; // 'TRANSPORT_PROBE'
 */
export function goldenAdmitted(name: GoldenExecution): AdmittedExecution {
  const bytes = frozenCoreFiles(name).core_files.get(EXECUTION_PATHS.executionManifest);
  const read = bytes === undefined ? undefined : readAdmittedExecution(bytes, validator);
  if (read?.ok !== true) {
    throw new Error(`the golden ${name} manifest does not read back; expected an admitted execution`);
  }
  return read.value;
}

/**
 * The files of the golden execution's package as admission and P2 froze them.
 *
 * @example
 * admittedFiles('run').some((file) => file.path === 'admission/execution-manifest.json'); // true
 */
export function admittedFiles(name: GoldenExecution): readonly PackageFile[] {
  return [...frozenCoreFiles(name).core_files].map(([path, bytes]) => ({ path, bytes }));
}
