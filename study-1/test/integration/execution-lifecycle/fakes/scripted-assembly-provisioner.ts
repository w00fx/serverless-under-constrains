// The deployment-assembly provisioner as P2 sees it, scripted: it records each subject it was asked
// to deploy and answers either the frozen provisioning the test supplies (a manifest with its
// digest, outputs and reasons, as `FrozenAssemblyProvisioner` returns after D1-D4) or the reasons
// no manifest could be frozen. The real provisioner's own deploy is covered by the
// deployment-assembly suites; this fake isolates the binding that reads its result.

import type { AssemblyProvisioner } from '../../../../src/execution-lifecycle/execution-provisioner.ts';
import type {
  FrozenProvisioning,
  ProvisioningSubject,
} from '../../../../src/deployment-assembly/frozen-assembly-provisioner.ts';
import { serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import { err, ok } from '../../../../src/record-contract/primitives.ts';
import type { Result, StructuredReason } from '../../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../../src/record-contract/records/group-a/resource_manifest.ts';

/** What the scripted provisioner answers: a frozen manifest with its reasons, or no manifest. */
export type ScriptedProvisioning =
  | { readonly kind: 'frozen'; readonly manifest: ResourceManifest; readonly reasons?: readonly StructuredReason[] }
  | { readonly kind: 'unfrozen'; readonly reasons: readonly StructuredReason[] };

/**
 * Answers every deploy with the scripted provisioning.
 *
 * @example
 * const assembly = new ScriptedAssemblyProvisioner({ kind: 'frozen', manifest });
 * await new FrozenAssemblyExecutionProvisioner(assembly).provision(admitted);
 */
export class ScriptedAssemblyProvisioner implements AssemblyProvisioner {
  readonly #answer: ScriptedProvisioning;
  readonly #subjects: ProvisioningSubject[] = [];

  constructor(answer: ScriptedProvisioning) {
    this.#answer = answer;
  }

  /** The subjects deployed, in call order. */
  subjects(): readonly ProvisioningSubject[] {
    return [...this.#subjects];
  }

  provision(subject: ProvisioningSubject): Promise<Result<FrozenProvisioning, readonly StructuredReason[]>> {
    this.#subjects.push(subject);
    const answer = this.#answer;
    if (answer.kind === 'unfrozen') {
      return Promise.resolve(err(answer.reasons));
    }
    return Promise.resolve(
      ok({
        resource_manifest: answer.manifest,
        resource_manifest_sha256: sha256Hex(serializeRecordFile(answer.manifest)),
        outputs: answer.manifest.outputs,
        reasons: answer.reasons ?? [],
      }),
    );
  }
}
