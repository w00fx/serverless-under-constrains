// P2 without a cloud: the deploy is one recorded mutation, and the resource manifest the test
// supplies is what provisioning froze. With `files`, the manifest is written into the package as
// the real deployment does (design §9.8 D1-D4); a deploy that did not succeed leaves its manifest
// and no targets, which sends the runner straight to emergency cleanup.

import type {
  AdmittedExecution,
  ExecutionProvisioner,
  ExecutionTargets,
  ProvisioningOutcome,
} from '../../../../src/execution-lifecycle/execution-ports.ts';
import type { PackageFileSystem } from '../../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { StructuredReason } from '../../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../../src/record-contract/records/group-a/resource_manifest.ts';
import type { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';

/** What the offline deploy leaves behind. */
export interface OfflineProvisionerOptions {
  /** The exact resource manifest bytes provisioning froze. */
  readonly bytes: Uint8Array;
  /** The targets of a succeeded deploy; absent when the deploy failed. */
  readonly targets?: ExecutionTargets;
  readonly reasons?: readonly StructuredReason[];
  readonly log: RecordingMutationLog;
  /** Where the manifest is written; omitted when the package already holds it. */
  readonly files?: PackageFileSystem;
  /** Runs while the deploy is in flight, for example an operator abort. */
  readonly during?: () => void;
}

/**
 * A provisioner that records the deploy and answers the scripted outcome.
 *
 * @example
 * const provisioner = new OfflineProvisioner({ bytes, targets, log });
 * (await provisioner.provision(admitted)).targets; // the scripted targets
 */
export class OfflineProvisioner implements ExecutionProvisioner {
  readonly #options: OfflineProvisionerOptions;
  #provisions = 0;

  constructor(options: OfflineProvisionerOptions) {
    this.#options = options;
  }

  /** How many deploys ran. */
  provisions(): number {
    return this.#provisions;
  }

  async provision(admitted: AdmittedExecution): Promise<ProvisioningOutcome> {
    this.#provisions += 1;
    const { bytes, targets, files, log } = this.#options;
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as ResourceManifest;
    log.record({ port: 'cloudformation', operation: 'CreateStack', target: manifest.stack_name });
    this.#options.during?.();
    const written =
      files === undefined
        ? { ok: true as const }
        : await files.writeOnce(`${admitted.package_directory}/${EXECUTION_PATHS.resourceManifest}`, bytes);
    const refusal: readonly StructuredReason[] = written.ok
      ? []
      : [
          {
            code: 'RESOURCE_MANIFEST_NOT_WRITTEN',
            subject: 'BR-RUA-040',
            detail: `${written.error.code}; expected a new file`,
          },
        ];
    return {
      resource_manifest: manifest,
      resource_manifest_sha256: sha256Hex(bytes),
      ...(targets === undefined ? {} : { targets }),
      reasons: [...(this.#options.reasons ?? []), ...refusal],
    };
  }
}
