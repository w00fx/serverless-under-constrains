// The coordination baseline deployment behind `rua coordination bootstrap` (design §9.1, §11;
// BR-RUA-045): the operator-managed stack `suc-study-1-coordination` holding the Study/account/
// Region lease table, deployed once per account from `infra/bin/coordination-app.ts`.
// - Synthesis is credential-free, exactly like the execution assembly's (`cdkSynthInvocation`):
//   no `AWS_*` variable, no config or credential file and no instance metadata, so it cannot
//   reach an account. The app then pins only the Region (us-east-1, BR-RUA-046).
// - Deployment runs from that synthesized assembly with the operator's credentials and
//   `--require-approval never`, like an execution stack's (`cdkDeployInvocation`), and writes its
//   outputs to `<work>/outputs.json`.
// UNVERIFIED (cloud phase): the CLI resolves the account of a Region-only assembly from the
// operator's credentials at deploy time; a real `rua coordination bootstrap` confirms it.
// The stack name and app path mirror `infra/stacks/coordination-stack.ts` and
// `infra/bin/coordination-app.ts`; src may not import infra/stacks, so a unit test pins them.

import { join } from 'node:path';

import { boundedJsonText } from '../record-contract/json-value.ts';
import { ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason, UtcMillis, WallClock } from '../record-contract/primitives.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { AssemblyFileSystem } from './assembly-file-system.ts';
import type { DeployReport } from './assembly-ports.ts';
import { cdkDeployInvocation, cdkSynthInvocation, SYNTH_OUTPUT_DIR } from './cdk-invocations.ts';
import type { CdkToolSettings } from './cdk-invocations.ts';
import { commandSucceeded, describeCommandResult } from './command-outcome.ts';
import type { CommandInvocation, CommandRunner } from './command-runner.ts';
import { parseStackOutputs } from './stack-outputs.ts';

/** The coordination baseline stack (`COORDINATION_STACK_NAME` of infra/stacks/coordination-stack.ts). */
export const COORDINATION_STACK = 'suc-study-1-coordination';
/** The coordination app, relative to the study root. */
export const COORDINATION_APP_ENTRY = 'infra/bin/coordination-app.ts';
/** The outputs file of the coordination deployment, inside the work directory. */
export const COORDINATION_OUTPUTS_FILE = 'outputs.json';
const COORDINATION_RULE = 'BR-RUA-045';

/**
 * The credential-free `cdk synth` of the coordination stack into `<workDir>/cdk.out`, or the
 * reason the Node path cannot be quoted for the `--app` command.
 *
 * @example
 * const synth = coordinationSynthInvocation(settings, '/study-1/.coordination-staging/<id>');
 * if (synth.ok) await runner.run(synth.value);
 */
export function coordinationSynthInvocation(
  settings: CdkToolSettings,
  workDir: string,
): Result<CommandInvocation, StructuredReason> {
  const base = cdkSynthInvocation(settings, workDir, COORDINATION_STACK);
  if (!base.ok) {
    return base;
  }
  return ok({
    ...base.value,
    args: [
      settings.cdk_cli_entry,
      'synth',
      COORDINATION_STACK,
      '--app',
      `"${settings.node_executable}" ${COORDINATION_APP_ENTRY}`,
      '--output',
      join(workDir, SYNTH_OUTPUT_DIR),
      '--no-lookups',
      '--no-version-reporting',
      '--no-notices',
      '--quiet',
    ],
  });
}

/**
 * The `cdk deploy` of the synthesized coordination assembly with the operator's credentials.
 *
 * @example
 * await runner.run(coordinationDeployInvocation(settings, '/study-1/.coordination-staging/<id>'));
 */
export function coordinationDeployInvocation(settings: CdkToolSettings, workDir: string): CommandInvocation {
  return cdkDeployInvocation(
    settings,
    join(workDir, SYNTH_OUTPUT_DIR),
    COORDINATION_STACK,
    join(workDir, COORDINATION_OUTPUTS_FILE),
  );
}

export interface CoordinationBaselineDeployerDeps {
  readonly runner: CommandRunner;
  readonly files: AssemblyFileSystem;
  readonly tools: CdkToolSettings;
  readonly clock: WallClock;
}

/**
 * Synthesizes and deploys the coordination baseline stack.
 *
 * @example
 * const deployer = new CoordinationBaselineDeployer({ runner, files, tools, clock });
 * const report = await deployer.deploy('/study-1/.coordination-staging/<id>');
 * report.deployed; // true when both commands exited 0 and the outputs were read
 */
export class CoordinationBaselineDeployer {
  readonly #deps: CoordinationBaselineDeployerDeps;

  constructor(deps: CoordinationBaselineDeployerDeps) {
    this.#deps = deps;
  }

  /**
   * Runs synthesis then deployment in `workDir`, which must be absent or empty; every failure is a
   * report with `deployed: false` and its reason, never a rejection.
   *
   * @example
   * const report = await deployer.deploy(workDir);
   * if (!report.deployed) printReasons(report.reasons);
   */
  async deploy(workDir: string): Promise<DeployReport> {
    const startedAt = this.#now();
    const unusable = await this.#unusableWorkDir(workDir);
    if (unusable !== undefined) {
      return this.#failed(startedAt, unusable);
    }
    const synth = coordinationSynthInvocation(this.#deps.tools, workDir);
    if (!synth.ok) {
      return this.#failed(startedAt, { ...synth.error, subject: COORDINATION_RULE });
    }
    const synthesized = await this.#deps.runner.run(synth.value);
    if (!commandSucceeded(synthesized)) {
      return this.#failed(
        startedAt,
        commandReason('COORDINATION_SYNTH_FAILED', 'synth', describeCommandResult(synthesized)),
      );
    }
    const deployed = await this.#deps.runner.run(coordinationDeployInvocation(this.#deps.tools, workDir));
    if (!commandSucceeded(deployed)) {
      return this.#failed(
        startedAt,
        commandReason('COORDINATION_DEPLOY_FAILED', 'deploy', describeCommandResult(deployed)),
      );
    }
    return this.#outputs(workDir, startedAt);
  }

  async #unusableWorkDir(workDir: string): Promise<StructuredReason | undefined> {
    const listed = await this.#deps.files.list(workDir);
    if ((!listed.ok && listed.error.code === 'NOT_FOUND') || (listed.ok && listed.value.length === 0)) {
      return undefined;
    }
    const found = listed.ok ? `${String(listed.value.length)} entries` : `${listed.error.code}: ${listed.error.detail}`;
    return coordinationReason(
      'COORDINATION_WORK_DIR_UNUSABLE',
      `${boundedJsonText(workDir)} holds ${found}; expected an absent or empty work directory`,
    );
  }

  async #outputs(workDir: string, startedAt: UtcMillis): Promise<DeployReport> {
    const bytes = await this.#deps.files.read(join(workDir, COORDINATION_OUTPUTS_FILE));
    if (!bytes.ok) {
      return this.#failed(
        startedAt,
        coordinationReason(
          'COORDINATION_OUTPUTS_UNREADABLE',
          `${bytes.error.code}: ${bytes.error.detail}; expected the outputs file cdk deploy writes`,
        ),
      );
    }
    const outputs = parseStackOutputs(bytes.value, COORDINATION_STACK);
    if (!outputs.ok) {
      return this.#failed(startedAt, { ...outputs.error, subject: COORDINATION_RULE });
    }
    return {
      stack_name: COORDINATION_STACK,
      deployed: true,
      started_at: startedAt,
      completed_at: this.#now(),
      outputs: outputs.value,
      reasons: [],
    };
  }

  #failed(startedAt: UtcMillis, reason: StructuredReason): DeployReport {
    return {
      stack_name: COORDINATION_STACK,
      deployed: false,
      started_at: startedAt,
      completed_at: this.#now(),
      outputs: [],
      reasons: [reason],
    };
  }

  #now(): UtcMillis {
    return formatUtcMillis(this.#deps.clock.now());
  }
}

function commandReason(code: string, command: string, outcome: string): StructuredReason {
  return coordinationReason(code, `cdk ${command} ${COORDINATION_STACK} ${outcome}; expected exit status 0`);
}

function coordinationReason(code: string, detail: string): StructuredReason {
  return { code, subject: COORDINATION_RULE, detail };
}
