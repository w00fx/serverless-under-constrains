// The ExecutionProvisioner binding (design §9.8 D1-D4; BR-RUA-040, BR-RUA-050): P2 runs the real
// `FrozenAssemblyProvisioner` (deployment-assembly) on the frozen assembly the execution manifest
// pins, and the runner reads the targets of the deploy from the resource manifest it froze
// (`executionTargetsOf`). The trials may start only when provisioning succeeded with no reason and
// the outputs name every target the stack must expose; a manifest whose outputs do not resolve
// adds that reason and keeps the targets back, so the runner goes to emergency cleanup. When the
// provisioner froze no manifest (the declared tags were refused before any deploy, or the built
// manifest is invalid) there is nothing cleanup can prove it owns.

import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { FrozenProvisioning, ProvisioningSubject } from '../deployment-assembly/frozen-assembly-provisioner.ts';
import type { AdmittedExecution, ExecutionProvisioner, ProvisioningOutcome } from './execution-ports.ts';
import { executionTargetsOf } from './execution-targets.ts';

/** The deployment-assembly provisioner as P2 calls it (`FrozenAssemblyProvisioner` in production). */
export interface AssemblyProvisioner {
  provision(subject: ProvisioningSubject): Promise<Result<FrozenProvisioning, readonly StructuredReason[]>>;
}

/**
 * P2 over the frozen deployment assembly.
 *
 * @example
 * const provisioner = new FrozenAssemblyExecutionProvisioner(new FrozenAssemblyProvisioner(deps));
 * (await provisioner.provision(admitted)).targets; // present once the deploy succeeded
 */
export class FrozenAssemblyExecutionProvisioner implements ExecutionProvisioner {
  readonly #assembly: AssemblyProvisioner;

  constructor(assembly: AssemblyProvisioner) {
    this.#assembly = assembly;
  }

  async provision(admitted: AdmittedExecution): Promise<ProvisioningOutcome> {
    const provisioned = await this.#assembly.provision({
      identity: admitted.identity,
      execution_manifest_sha256: admitted.manifest_sha256,
      deployment_assembly: admitted.manifest.deployment_assembly,
      package_directory: admitted.package_directory,
    });
    return provisioned.ok ? withTargets(provisioned.value) : { reasons: atLeastOne(provisioned.error) };
  }
}

/**
 * The provisioning outcome of a frozen manifest: its targets only when provisioning succeeded with
 * no reason and every target resolves.
 *
 * @example
 * withTargets(frozen).targets?.provider_version; // the published provider version after a clean deploy
 */
export function withTargets(frozen: FrozenProvisioning): ProvisioningOutcome {
  const base = {
    resource_manifest: frozen.resource_manifest,
    resource_manifest_sha256: frozen.resource_manifest_sha256,
  };
  if (frozen.reasons.length > 0) {
    return { ...base, reasons: frozen.reasons };
  }
  const targets = executionTargetsOf(frozen.resource_manifest);
  return targets.ok ? { ...base, targets: targets.value, reasons: [] } : { ...base, reasons: [targets.error] };
}

// The provisioner always names why it froze no manifest; an empty list still keeps the trials back.
function atLeastOne(reasons: readonly StructuredReason[]): readonly [StructuredReason, ...StructuredReason[]] {
  const [first, ...rest] = reasons;
  return first === undefined
    ? [
        {
          code: 'RESOURCE_MANIFEST_ABSENT',
          subject: 'BR-RUA-040',
          detail: 'provisioning froze no resource manifest and named no reason; expected a frozen resource manifest',
        },
      ]
    : [first, ...rest];
}
