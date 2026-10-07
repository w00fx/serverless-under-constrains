// The admitted execution a package operand names (design §7, §11; BR-RUA-040), as every command
// that acts on an admitted package reads it: the operand must be a package directory (of the
// command's kind, when it has one), else a usage error; its frozen execution manifest must read
// back and name that execution, else the package cannot be acted on (exit 5).

import type { AdmittedExecution } from '../execution-lifecycle/execution-ports.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { err } from '../record-contract/primitives.ts';
import type { ExecutionKind, Result } from '../record-contract/primitives.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { failedOutcome } from './cli-result.ts';
import type { CliOutcomeReport, CommandContext } from './cli-types.ts';
import { locatePackage, locatePackageOfKind } from './package-location.ts';
import { readPackageManifest } from './package-manifest.ts';

/** Where the package is read from. */
export interface AdmittedPackageSource {
  readonly files: PackageFileSystem;
  readonly validator: RecordValidator;
  /** The kind the command handles; any kind when absent. */
  readonly kind?: ExecutionKind;
}

/**
 * The admitted execution of the package operand `operand`, or the report that refuses it.
 *
 * @example
 * const admitted = await readAdmittedPackage(operandOf(args, 'package'), context, { files, validator });
 * if (!admitted.ok) return admitted.error;
 */
export async function readAdmittedPackage(
  operand: string,
  context: CommandContext,
  source: AdmittedPackageSource,
): Promise<Result<AdmittedExecution, CliOutcomeReport>> {
  const packagePath = context.resolvePath(operand);
  const located =
    source.kind === undefined
      ? locatePackage(context.evidence_root, packagePath)
      : locatePackageOfKind(context.evidence_root, packagePath, source.kind);
  if (!located.ok) {
    return err(failedOutcome('usage_error', [located.error]));
  }
  const admitted = await readPackageManifest(source.files, located.value, source.validator);
  return admitted.ok ? admitted : err(failedOutcome('verification_failed', [admitted.error]));
}
