// P9 (design §10.2, §7; BR-RUA-043, BR-RUA-044, CTR-RUA-002): the summary records, then the journals
// made read-only, then `package-index.json`, written last so it hashes every other file of the
// package exactly as finalized. A run's summary is the comparison assessment and the run summary
// derived from the frozen records (`finalizeRunAssessments`) and the deployment projection of the
// frozen run template (Owner amendment A-13); a probe binds `TransportProbeSummaryWriter` and a
// validation `ValidationSummaryWriter`.

import { projectDeploymentTemplate } from '../deployment-assembly/deployment-projection.ts';
import type { DeploymentTemplateProjection } from '../deployment-assembly/deployment-projection.ts';
import type { AppendOnlyFile } from '../event-journal/append-only-file.ts';
import { buildPackageIndex } from '../evidence-package/package-index.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { FrozenDeploymentAssembly } from '../record-contract/records/group-a/execution_manifest.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { finalizeRunAssessments } from '../study-comparison/run-package-assessment.ts';
import { readRunPackage } from '../study-comparison/run-package-reader.ts';
import type { AdmittedExecution } from './execution-ports.ts';
import type { ExecutionPackage } from './execution-package.ts';
import { filesByPath } from './execution-package.ts';

/** Writes the lifecycle summary of one execution kind (P9). */
export interface SummaryWriter {
  write(
    pkg: ExecutionPackage,
    admitted: AdmittedExecution,
    finalizedAt: UtcMillis,
  ): Promise<readonly StructuredReason[]>;
}

/** The journals a package holds; each present one is made read-only before the index. */
export const PACKAGE_JOURNAL_PATHS: readonly string[] = [
  EXECUTION_PATHS.coordinationJournal,
  EXECUTION_PATHS.provisioningJournal,
  EXECUTION_PATHS.runnerJournal,
  EXECUTION_PATHS.cleanupJournal,
];

/**
 * The run summary writer: `summary/comparison-assessment.json` and `summary/run-summary.json`.
 *
 * @example
 * const reasons = await new RunSummaryWriter(validator).write(pkg, admitted, finalizedAt); // [] once both are written
 */
export class RunSummaryWriter implements SummaryWriter {
  readonly #validator: RecordValidator;

  constructor(validator: RecordValidator) {
    this.#validator = validator;
  }

  async write(
    pkg: ExecutionPackage,
    admitted: AdmittedExecution,
    finalizedAt: UtcMillis,
  ): Promise<readonly StructuredReason[]> {
    const files = await pkg.snapshot();
    if (!files.ok) {
      return [files.error];
    }
    const records = readRunPackage(filesByPath(files.value), { validator: this.#validator, digest: sha256Hex });
    if (!records.ok) {
      return records.error;
    }
    const finalized = finalizeRunAssessments(
      records.value,
      {
        deployment: frozenDeploymentProjection(filesByPath(files.value), admitted.manifest.deployment_assembly),
        contradictory_amendments: [],
        finalized_at: finalizedAt,
      },
      sha256Hex,
    );
    if (!finalized.ok) {
      return finalized.error;
    }
    const { comparison_assessment: comparison, run_summary: summary } = finalized.value;
    return [
      await pkg.writeOnce(comparison.path, comparison.bytes),
      await pkg.writeOnce(summary.path, summary.bytes),
    ].filter((reason) => reason !== undefined);
  }
}

/**
 * The deployment projection of the run template the execution manifest froze (A-13), read from its
 * package-relative `template_path` and checked against its `template_sha256`; undefined when the
 * template is not in the package or cannot be projected, which leaves the template-derived equality
 * projections indeterminate rather than failing the summary.
 *
 * @example
 * frozenDeploymentProjection(filesByPath(files), admitted.manifest.deployment_assembly)?.variants.durable;
 */
export function frozenDeploymentProjection(
  files: ReadonlyMap<string, Uint8Array>,
  assembly: FrozenDeploymentAssembly,
): DeploymentTemplateProjection | undefined {
  const bytes = files.get(assembly.template_path);
  if (bytes === undefined) {
    return undefined;
  }
  const projection = projectDeploymentTemplate({
    template_path: assembly.template_path,
    template_bytes: bytes,
    template_sha256: assembly.template_sha256,
  });
  return projection.ok ? projection.value : undefined;
}

/**
 * Makes every journal of the package read-only and writes `package-index.json` last; the index
 * digest, or every reason the package could not be finalized.
 *
 * @example
 * const index = await finalizePackage(pkg, journals, admitted, now);
 * if (index.ok) index.value; // the package index digest
 */
export async function finalizePackage(
  pkg: ExecutionPackage,
  journals: AppendOnlyFile,
  admitted: AdmittedExecution,
  createdAt: UtcMillis,
): Promise<Result<Sha256Hex, readonly StructuredReason[]>> {
  const before = await pkg.snapshot();
  if (!before.ok) {
    return err([before.error]);
  }
  const present = new Set(before.value.map((file) => file.path));
  const reasons: StructuredReason[] = [];
  for (const path of PACKAGE_JOURNAL_PATHS.filter((journal) => present.has(journal))) {
    const finalized = await journals.finalize(`${admitted.package_directory}/${path}`);
    if (finalized.kind === 'failed') {
      reasons.push(finalizationReason(path, `the journal was not made read-only (${finalized.code})`));
    }
  }
  // Finalizing changes a journal's mode, never its bytes (`node-append-only-file.ts`: mode 0444),
  // so the snapshot taken before it is the package exactly as the index must hash it.
  const index = buildPackageIndex({ files: before.value, identity: admitted.identity, created_at: createdAt });
  if (!index.ok || reasons.length > 0) {
    return err([...reasons, ...(index.ok ? [] : index.error)]);
  }
  const bytes = serializeRecordFile(index.value);
  const unwritten = await pkg.writeOnce(EXECUTION_PATHS.packageIndex, bytes);
  return unwritten === undefined ? ok(sha256Hex(bytes)) : err([unwritten]);
}

function finalizationReason(path: string, problem: string): StructuredReason {
  return {
    code: 'PACKAGE_NOT_FINALIZED',
    subject: 'BR-RUA-044',
    artifact_path: path,
    detail: `${path}: ${problem}; expected every journal finalized before package-index.json`,
  };
}
