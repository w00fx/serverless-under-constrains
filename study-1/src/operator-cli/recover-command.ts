// `rua recover <package> --confirm-cloud-mutation <id>` (design §10.4, §11; BR-RUA-038,
// BR-RUA-048, BR-RUA-051): reruns cleanup steps 3 to 11 against a finalized package and writes one
// OPERATIONAL_RECOVERY amendment (`recoverExecution`). The cleanup adapters are bound to the
// discovery targets of the package's own frozen resource manifest, so the recovery acts on, and
// audits, exactly what the original cleanup did; a package whose manifest cannot bind them is
// refused before any cloud call. The exit code is the recovered closure's: 0 clean and released,
// 6 not clean, 7 lease unverified; a refusal is 5, and an amendment that could not be stored 10.

import type { DiscoveryTargets } from '../cleanup/discovery-targets.ts';
import { discoveryTargetsOf } from '../cleanup/discovery-targets.ts';
import type { AdmittedExecution } from '../execution-lifecycle/execution-ports.ts';
import type { RecoveryOutcome } from '../execution-lifecycle/operational-recovery.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, executionIdOf } from '../evidence-package/package-layout.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err } from '../record-contract/primitives.ts';
import type { JsonObject, Result, StructuredReason } from '../record-contract/primitives.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { readAdmittedPackage } from './admitted-package.ts';
import { amendmentRefusal, amendmentWrittenPath } from './amendment-report.ts';
import { operandOf } from './arg-parsing.ts';
import { failedOutcome } from './cli-result.ts';
import type { CliCommand, CliOutcomeReport, CommandContext, CommandSpec, ParsedArgs } from './cli-types.ts';
import { CONFIRM_FLAG, confirmCloudMutation } from './cloud-confirmation.ts';
import { closureVerdict } from './execution-exit.ts';

/** One recovery to run: the admitted execution and the targets its adapters are bound to. */
export interface RecoveryRequest {
  readonly admitted: AdmittedExecution;
  readonly targets: DiscoveryTargets;
  readonly evidence_root: string;
}

/** Runs `recoverExecution` over adapters bound to the request's targets (production: AWS). */
export type RecoveryLauncher = (
  request: RecoveryRequest,
) => Promise<Result<RecoveryOutcome, readonly StructuredReason[]>>;

/** What the command reads and runs through. */
export interface RecoverCommandDeps {
  readonly files: (evidenceRoot: string) => PackageFileSystem;
  readonly validator: RecordValidator;
  readonly recover: RecoveryLauncher;
}
const PACKAGE_OPERAND = 'package';

/**
 * `recover <package> --confirm-cloud-mutation <execution_id>`.
 *
 * @example
 * await main(['recover', 'evidence/runs/<id>', '--confirm-cloud-mutation', '<id>'], io, root);
 */
export class RecoverCommand implements CliCommand {
  readonly spec: CommandSpec = {
    words: ['recover'],
    positionals: [PACKAGE_OPERAND],
    flags: new Map([[CONFIRM_FLAG, 'required']]),
    usage: `recover <package> --${CONFIRM_FLAG} <execution_id>`,
  };
  readonly #deps: RecoverCommandDeps;

  constructor(deps: RecoverCommandDeps) {
    this.#deps = deps;
  }

  async run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    const files = this.#deps.files(context.evidence_root);
    const admitted = await readAdmittedPackage(operandOf(args, PACKAGE_OPERAND), context, {
      files,
      validator: this.#deps.validator,
    });
    if (!admitted.ok) {
      return admitted.error;
    }
    const confirmed = confirmCloudMutation(args, executionIdOf(admitted.value.identity));
    if (!confirmed.ok) {
      return failedOutcome('usage_error', [confirmed.error]);
    }
    const targets = await frozenDiscoveryTargets(files, admitted.value, this.#deps.validator);
    if (!targets.ok) {
      return { ...failedOutcome('verification_failed', [targets.error]), execution: admitted.value.identity };
    }
    context.progress(`recovering ${admitted.value.package_directory}`);
    const recovered = await this.#deps.recover({
      admitted: admitted.value,
      targets: targets.value,
      evidence_root: context.evidence_root,
    });
    return recovered.ok
      ? recoveredReport(admitted.value, recovered.value)
      : amendmentRefusal(admitted.value.identity, recovered.error);
  }
}

/**
 * The discovery targets of the package's frozen resource manifest, or why it cannot bind them.
 *
 * @example
 * const targets = await frozenDiscoveryTargets(files, admitted, validator);
 * if (targets.ok) bindAwsCleanupPorts(clients, targets.value);
 */
export async function frozenDiscoveryTargets(
  files: PackageFileSystem,
  admitted: AdmittedExecution,
  validator: RecordValidator,
): Promise<Result<DiscoveryTargets, StructuredReason>> {
  const path = `${admitted.package_directory}/${EXECUTION_PATHS.resourceManifest}`;
  const bytes = await files.read(path);
  const parsed = bytes.ok ? parseJsonDocument(bytes.value) : bytes;
  const checked = parsed.ok ? validator.validateAs('resource_manifest', parsed.value) : undefined;
  if (checked?.valid !== true) {
    const problem = bytes.ok ? 'is not a valid resource_manifest' : `cannot be read (${bytes.error.code})`;
    return err({
      code: 'RESOURCE_MANIFEST_UNREADABLE',
      subject: 'BR-RUA-050',
      artifact_path: EXECUTION_PATHS.resourceManifest,
      detail: `${path} ${problem}; expected the resource manifest P2 froze`,
    });
  }
  return discoveryTargetsOf({ manifest: checked.record as ResourceManifest, execution: admitted.identity });
}

function recoveredReport(admitted: AdmittedExecution, recovered: RecoveryOutcome): CliOutcomeReport {
  const { record } = recovered;
  const verdict = closureVerdict(record.recovered_closure);
  return {
    outcome: verdict.outcome,
    execution: admitted.identity,
    written_paths: [amendmentWrittenPath(recovered.amendment_directory)],
    result_record: record as unknown as JsonObject,
    reasons: verdict.reason === undefined ? record.reasons : [...record.reasons, verdict.reason],
  };
}
