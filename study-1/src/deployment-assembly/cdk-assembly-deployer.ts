// The production AssemblyDeployer (design §9.8 D2; D-25): `cdk deploy` of one stack from a verified
// temporary copy, never from the package copy, because the CLI writes its lock files into the
// `--app` directory (RF V1, RK-13). The report records when the deployment started and ended on
// the injected wall clock, and the outputs the CLI wrote for this stack. A failed command or an
// unreadable outputs file is a report with `deployed: false` and its reason, never a rejection:
// provisioning still freezes a `partial` or `failed` resource manifest (BR-RUA-040).

import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { StructuredReason, UtcMillis, WallClock } from '../record-contract/primitives.ts';
import type { AssemblyFileSystem } from './assembly-file-system.ts';
import type { AssemblyDeployer, DeployReport, VerifiedDeployCopy } from './assembly-ports.ts';
import { cdkDeployInvocation } from './cdk-invocations.ts';
import type { CdkToolSettings } from './cdk-invocations.ts';
import { commandSucceeded, describeCommandResult } from './command-outcome.ts';
import type { CommandRunner } from './command-runner.ts';
import { deploymentReason } from './deployment-reasons.ts';
import { parseStackOutputs } from './stack-outputs.ts';

export interface CdkAssemblyDeployerDeps {
  readonly runner: CommandRunner;
  readonly files: AssemblyFileSystem;
  readonly tools: CdkToolSettings;
  readonly clock: WallClock;
}

/**
 * Deploys verified copies with the pinned CDK CLI.
 *
 * @example
 * const deployer = new CdkAssemblyDeployer({ runner, files, tools, clock });
 * const report = await deployer.deploy(copy, 'SucRua-run-3f1c2a9e', '/work/deploy/outputs.json');
 * report.deployed; // true when cdk exited 0 and wrote this stack's outputs
 */
export class CdkAssemblyDeployer implements AssemblyDeployer {
  readonly #deps: CdkAssemblyDeployerDeps;

  constructor(deps: CdkAssemblyDeployerDeps) {
    this.#deps = deps;
  }

  /**
   * Runs `cdk deploy` on the copy and reads the outputs file.
   *
   * @example
   * await deployer.deploy(copy, stackName, outputsFile);
   */
  async deploy(copy: VerifiedDeployCopy, stackName: string, outputsFile: string): Promise<DeployReport> {
    const startedAt = this.#now();
    const result = await this.#deps.runner.run(cdkDeployInvocation(this.#deps.tools, copy.dir, stackName, outputsFile));
    if (!commandSucceeded(result)) {
      return this.#failed(stackName, startedAt, [
        deploymentReason(
          'DEPLOY_COMMAND_FAILED',
          'BR-RUA-040',
          `cdk deploy ${stackName} ${describeCommandResult(result)}; expected exit status 0`,
        ),
      ]);
    }
    const bytes = await this.#deps.files.read(outputsFile);
    if (!bytes.ok) {
      return this.#failed(stackName, startedAt, [
        deploymentReason(
          'OUTPUTS_UNREADABLE',
          'BR-RUA-040',
          `${bytes.error.code}: ${bytes.error.detail}; expected the outputs file cdk deploy writes`,
        ),
      ]);
    }
    const outputs = parseStackOutputs(bytes.value, stackName);
    if (!outputs.ok) {
      return this.#failed(stackName, startedAt, [outputs.error]);
    }
    return {
      stack_name: stackName,
      deployed: true,
      started_at: startedAt,
      completed_at: this.#now(),
      outputs: outputs.value,
      reasons: [],
    };
  }

  #failed(stackName: string, startedAt: UtcMillis, reasons: readonly StructuredReason[]): DeployReport {
    return {
      stack_name: stackName,
      deployed: false,
      started_at: startedAt,
      completed_at: this.#now(),
      outputs: [],
      reasons,
    };
  }

  #now(): UtcMillis {
    return formatUtcMillis(this.#deps.clock.now());
  }
}
