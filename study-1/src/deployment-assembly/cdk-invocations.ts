// The exact CDK CLI command lines of synthesis (design §9.8 S1) and deployment (D2). Both run the
// pinned CLI of the lockfile under an explicit Node executable, because the system default Node is
// not the study's Node 24 (addendum §4), and both point `CDK_DOCKER` at the forbidden sentinel, so a
// missing local esbuild fails instead of silently bundling in Docker (RK-11, CF V-10). Neither
// sends telemetry nor fetches notices.
//
// Synthesis needs no AWS identity: the context names the account and Region and lookups are off.
// Its environment therefore drops every `AWS_*` variable, points the shared config and credential
// files at a path that does not exist and disables the instance metadata service, so `cdk synth`
// cannot reach an account even when the operator's shell holds credentials. Deployment keeps the
// operator's environment, because it must reach the account.

import { join } from 'node:path';

import { EXECUTION_CONTEXT_KEY } from '../../infra/ownership/execution-context.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { CommandInvocation } from './command-runner.ts';
import { deploymentReason } from './deployment-reasons.ts';

/** The app every synthesis runs, relative to the study root (design §5.1 `cdk.json`). */
export const STUDY_APP_ENTRY = 'infra/bin/study-app.ts';
/** The file synthesis writes into the staging directory for the app to read. */
export const EXECUTION_CONTEXT_FILE = 'execution-context.json';
/** The cloud assembly directory inside the staging directory. */
export const SYNTH_OUTPUT_DIR = 'cdk.out';
/** A path inside the staging directory that is never created: the AWS config files of synthesis. */
export const ABSENT_AWS_CONFIG_FILE = 'no-aws-config';

/** Where the pinned tools live and the environment the operator runs them from. */
export interface CdkToolSettings {
  /** The Node 24 executable (`process.execPath` in production). */
  readonly node_executable: string;
  /** The lockfile's CDK CLI entry: `<study>/node_modules/aws-cdk/bin/cdk`. */
  readonly cdk_cli_entry: string;
  /** The study root; synthesis runs the app from here. */
  readonly study_root: string;
  /** `<study>/tools/docker-forbidden.sh`, which always exits 1. */
  readonly docker_sentinel: string;
  /** The operator's environment (`process.env` in production). */
  readonly environment: Readonly<Record<string, string | undefined>>;
}

// Characters a POSIX shell would interpret inside the double quotes of the `--app` command.
const SHELL_ACTIVE = /["$`\\\n\r]/;

/**
 * The `cdk synth` invocation that writes the assembly to `<stagingDir>/cdk.out` from the context
 * file `<stagingDir>/execution-context.json`, or a reason when the Node path cannot be quoted for
 * the `--app` command the CLI hands to a shell.
 *
 * @example
 * const invocation = cdkSynthInvocation(settings, '/work/attempt/staging', 'SucRua-run-3f1c2a9e');
 * if (invocation.ok) await runner.run(invocation.value);
 */
export function cdkSynthInvocation(
  settings: CdkToolSettings,
  stagingDir: string,
  stackName: string,
): Result<CommandInvocation, StructuredReason> {
  if (SHELL_ACTIVE.test(settings.node_executable)) {
    return err(
      deploymentReason(
        'UNQUOTABLE_NODE_PATH',
        'BR-RUA-042',
        `node executable ${boundedJsonText(settings.node_executable)} holds a shell-active character; expected a path without " $ \` \\ or line breaks`,
      ),
    );
  }
  return ok({
    executable: settings.node_executable,
    args: [
      settings.cdk_cli_entry,
      'synth',
      stackName,
      '--app',
      `"${settings.node_executable}" ${STUDY_APP_ENTRY}`,
      '--output',
      join(stagingDir, SYNTH_OUTPUT_DIR),
      '--context',
      `${EXECUTION_CONTEXT_KEY}=${join(stagingDir, EXECUTION_CONTEXT_FILE)}`,
      '--no-lookups',
      '--path-metadata',
      '--no-version-reporting',
      '--no-notices',
      '--quiet',
    ],
    cwd: settings.study_root,
    env: {
      ...withoutAwsVariables(settings.environment),
      ...toolVariables(settings),
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_CONFIG_FILE: join(stagingDir, ABSENT_AWS_CONFIG_FILE),
      AWS_SHARED_CREDENTIALS_FILE: join(stagingDir, ABSENT_AWS_CONFIG_FILE),
    },
  });
}

/**
 * The `cdk deploy` invocation of one stack from a verified copy (design §9.8 D2). The CLI writes
 * its lock files into the `--app` directory (RF V1), which is why that is never the package copy.
 *
 * @example
 * await runner.run(cdkDeployInvocation(settings, copy.dir, 'SucRua-run-3f1c2a9e', '/work/outputs.json'));
 */
export function cdkDeployInvocation(
  settings: CdkToolSettings,
  copyDir: string,
  stackName: string,
  outputsFile: string,
): CommandInvocation {
  return {
    executable: settings.node_executable,
    args: [
      settings.cdk_cli_entry,
      'deploy',
      stackName,
      '--app',
      copyDir,
      '--exclusively',
      '--require-approval',
      'never',
      '--outputs-file',
      outputsFile,
      '--no-version-reporting',
      '--no-notices',
    ],
    cwd: settings.study_root,
    env: { ...definedVariables(settings.environment), ...toolVariables(settings) },
  };
}

function toolVariables(settings: CdkToolSettings): Readonly<Record<string, string>> {
  return { CDK_DOCKER: settings.docker_sentinel, CDK_DISABLE_CLI_TELEMETRY: 'true' };
}

function withoutAwsVariables(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(definedVariables(environment)).filter(([key]) => !key.startsWith('AWS_')));
}

function definedVariables(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) {
      defined[key] = value;
    }
  }
  return defined;
}
