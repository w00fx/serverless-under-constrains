// The coordination baseline commands (design §9.1, §10.1 A8, §11; BR-RUA-045):
// - `coordination bootstrap --confirm-cloud-mutation coordination` deploys the operator-managed
//   stack `suc-study-1-coordination` (`CoordinationBaselineDeployer`); it writes nothing under the
//   evidence root, and its stack outputs (the lease table the environment input must name) are
//   printed on stderr. A deploy that did not complete is exit 4.
// - `coordination verify --env <file>` runs admission's read-only step A8 on its own: the table's
//   key schema, TTL and deletion protection, then the lease item. The design's table lists the
//   command without flags; the expected table and schema version live in the operator's
//   environment input, so it takes the same `--env` file admission takes (evidence/WP-28/
//   decisions.md). Exit 0 when admission would pass A8, 7 on a conflicting holder, 5 on a
//   configuration problem; an unreadable or invalid input is a usage error.

import type { CoordinationReadings } from '../admission/coordination-check.ts';
import { assessCoordination } from '../admission/coordination-check.ts';
import { validateEnvironmentInput } from '../admission/environment-input.ts';
import type { DeployReport } from '../deployment-assembly/assembly-ports.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { EnvironmentInput } from '../record-contract/records/group-a/environment_input.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { InputFileReader } from './admit-commands.ts';
import { flagValue, usageReason } from './arg-parsing.ts';
import { failedOutcome } from './cli-result.ts';
import type { CliCommand, CliOutcomeReport, CommandContext, CommandSpec, ParsedArgs } from './cli-types.ts';
import { CONFIRM_FLAG, COORDINATION_CONFIRMATION, confirmCloudMutation } from './cloud-confirmation.ts';

/** Deploys the coordination baseline (production: `CoordinationBaselineDeployer` in a fresh work directory). */
export type CoordinationDeploy = () => Promise<DeployReport>;

/** Reads step A8's table description and lease item for one environment (production: AWS, read-only). */
export type CoordinationReader = (environment: EnvironmentInput) => Promise<CoordinationReadings>;

/**
 * `coordination bootstrap --confirm-cloud-mutation coordination`.
 *
 * @example
 * await main(['coordination', 'bootstrap', '--confirm-cloud-mutation', 'coordination'], io, root);
 */
export class CoordinationBootstrapCommand implements CliCommand {
  readonly spec: CommandSpec = {
    words: ['coordination', 'bootstrap'],
    positionals: [],
    flags: new Map([[CONFIRM_FLAG, 'required']]),
    usage: `coordination bootstrap --${CONFIRM_FLAG} ${COORDINATION_CONFIRMATION}`,
  };
  readonly #deploy: CoordinationDeploy;

  constructor(deploy: CoordinationDeploy) {
    this.#deploy = deploy;
  }

  async run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    const confirmed = confirmCloudMutation(args, COORDINATION_CONFIRMATION);
    if (!confirmed.ok) {
      return failedOutcome('usage_error', [confirmed.error]);
    }
    context.progress('deploying the coordination baseline');
    const report = await this.#deploy();
    for (const output of report.outputs) {
      context.progress(`${report.stack_name} output ${output.key}=${output.value}`);
    }
    return report.deployed
      ? { outcome: 'completed', written_paths: [], reasons: [] }
      : failedOutcome('execution_incomplete', atLeastOne(report));
  }
}

const ENV_FLAG = 'env';

/** What `coordination verify` reads. */
export interface CoordinationVerifyDeps {
  readonly inputs: InputFileReader;
  readonly validator: RecordValidator;
  readonly read: CoordinationReader;
}

/**
 * `coordination verify --env <file>`.
 *
 * @example
 * await main(['coordination', 'verify', '--env', 'environment.json'], io, root);
 */
export class CoordinationVerifyCommand implements CliCommand {
  readonly spec: CommandSpec = {
    words: ['coordination', 'verify'],
    positionals: [],
    flags: new Map([[ENV_FLAG, 'required']]),
    usage: `coordination verify --${ENV_FLAG} <file>`,
  };
  readonly #deps: CoordinationVerifyDeps;

  constructor(deps: CoordinationVerifyDeps) {
    this.#deps = deps;
  }

  async run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    const environment = await this.#environment(context.resolvePath(flagValue(args.flags, ENV_FLAG)));
    if (!environment.ok) {
      return failedOutcome('usage_error', [environment.error]);
    }
    context.progress(`verifying ${environment.value.coordination_table_arn}`);
    const verdict = assessCoordination(await this.#deps.read(environment.value), environment.value);
    if (verdict.passed) {
      return { outcome: 'completed', written_paths: [], reasons: [] };
    }
    return failedOutcome(
      verdict.rejection_class === 'SAFETY' ? 'lease_problem' : 'verification_failed',
      verdict.reasons,
    );
  }

  async #environment(path: string): Promise<Result<EnvironmentInput, StructuredReason>> {
    const bytes = await this.#deps.inputs.readBytes(path);
    const parsed = bytes.ok ? parseJsonDocument(bytes.value) : bytes;
    const input = parsed.ok ? validateEnvironmentInput(parsed.value, this.#deps.validator) : parsed;
    if (input.ok) {
      return input;
    }
    const problem = bytes.ok ? 'is not a valid environment_input' : `cannot be read (${bytes.error.code})`;
    return err(
      usageReason(`--${ENV_FLAG} ${boundedJsonText(path)} ${problem}`, 'a readable environment_input JSON file'),
    );
  }
}

// A failed deploy always names why; an empty list still reports the incomplete deploy.
function atLeastOne(report: DeployReport): readonly StructuredReason[] {
  return report.reasons.length > 0
    ? report.reasons
    : [
        {
          code: 'COORDINATION_NOT_DEPLOYED',
          subject: 'BR-RUA-045',
          detail: `${report.stack_name} was not deployed and no reason was given; expected a deployed baseline`,
        },
      ];
}
