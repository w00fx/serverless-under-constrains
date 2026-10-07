// Wiring only (design §15.4: excluded from the mutation targets): binds every operator command of
// design §11 to its production adapters. Decisions live in the command modules and the features
// they call; this file only constructs objects. The commands that mutate the cloud are
// `coordination bootstrap`, `probe|validation|run execute` and `recover`; each is gated by its
// `--confirm-cloud-mutation` value inside the command.

import { resolve } from 'node:path';

import { ChildProcessCommandRunner } from '../deployment-assembly/node/child-process-command-runner.ts';
import { NodePackageFileSystem } from '../evidence-package/node/node-package-file-system.ts';
import { createRecordValidator } from '../record-contract/schema-registry.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { AdmitCommand } from './admit-commands.ts';
import { createAwsExecutionAdmitter } from './aws/aws-execution-admitter.ts';
import type { AwsCompositionSettings } from './aws/aws-cdk-tools.ts';
import { createAwsLateEvidenceLauncher, createAwsRecoveryLauncher } from './aws/aws-amendment-services.ts';
import { createAwsCoordinationDeploy, createAwsCoordinationReader } from './aws/aws-coordination.ts';
import { createAwsExecutionSessions } from './aws/aws-execution-session.ts';
import { BillingImportCommand } from './billing-import-command.ts';
import { OWNER_SIGNED_BILLING_FACTS } from './billing-facts.ts';
import type { CliCommand, CompositionRoot } from './cli-types.ts';
import { CoordinationBootstrapCommand, CoordinationVerifyCommand } from './coordination-commands.ts';
import { ExecuteCommand } from './execute-commands.ts';
import type { ExecuteCommandDeps } from './execute-commands.ts';
import { LateEvidenceAssessCommand } from './late-evidence-command.ts';
import { GitRevisionWorkspace } from './node/git-revision-workspace.ts';
import { NodeDeliveryDirectory } from './node/node-delivery-directory.ts';
import { NodeInputFileReader } from './node/node-input-file-reader.ts';
import { ProcessInterruptSignals } from './node/process-interrupts.ts';
import { processServices } from './node/process-services.ts';
import { OracleEvaluateCommand } from './oracle-evaluate-command.ts';
import { OracleRevisionCheckCommand } from './oracle-revision-check.ts';
import { RecoverCommand } from './recover-command.ts';
import { StoredQualificationReader } from './run-completion-inputs.ts';
import { RunVerifyCommand } from './run-verify-command.ts';
import { ProbeVerifyCommand, ValidationVerifyCommand } from './verify-commands.ts';

/** Where the CLI runs: its study root, working directory, environment and temporary directory. */
export interface CompositionSettings {
  /** Absolute path of `study-1/`. */
  readonly studyRoot: string;
  /** The working directory operand and flag paths are resolved against. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly tempRoot: string;
  readonly nodeVersion: string;
  /** The Node executable synthesis runs the CDK app with (`process.execPath`). */
  readonly nodeExecutable: string;
}

/**
 * The production composition of every operator command.
 *
 * @example
 * const root = createCompositionRoot({ studyRoot, cwd: process.cwd(), env: process.env, tempRoot: tmpdir(), nodeVersion: process.version, nodeExecutable: process.execPath });
 */
export function createCompositionRoot(settings: CompositionSettings): CompositionRoot {
  const validator = createRecordValidator();
  const clock = { now: (): Date => new Date() };
  const env = definedEnvironment(settings.env);
  const files = (evidenceRoot: string): NodePackageFileSystem => new NodePackageFileSystem(evidenceRoot);
  const aws: AwsCompositionSettings = {
    studyRoot: settings.studyRoot,
    nodeExecutable: settings.nodeExecutable,
    env,
    validator,
  };
  const commands: readonly CliCommand[] = [
    new CoordinationBootstrapCommand(createAwsCoordinationDeploy(aws, clock)),
    new CoordinationVerifyCommand({
      inputs: new NodeInputFileReader(),
      validator,
      read: createAwsCoordinationReader(),
    }),
    ...admitCommands(settings, env, validator),
    ...executeCommands({
      files,
      validator,
      sessions: createAwsExecutionSessions(aws),
      interrupts: new ProcessInterruptSignals(),
    }),
    new ProbeVerifyCommand({ files, validator, clock }),
    new ValidationVerifyCommand({ files, validator, clock }),
    new RunVerifyCommand({ files, validator, clock, qualifications: new StoredQualificationReader(clock, validator) }),
    new RecoverCommand({ files, validator, recover: createAwsRecoveryLauncher(validator) }),
    new LateEvidenceAssessCommand({ files, validator, assess: createAwsLateEvidenceLauncher(validator) }),
    new BillingImportCommand({
      files,
      deliveries: new NodeDeliveryDirectory(),
      facts: OWNER_SIGNED_BILLING_FACTS,
      services: processServices(validator),
    }),
    new OracleEvaluateCommand({ files, validator, clock }),
    new OracleRevisionCheckCommand({
      workspace: new GitRevisionWorkspace({
        runner: new ChildProcessCommandRunner(),
        studyRoot: settings.studyRoot,
        tempRoot: settings.tempRoot,
        env,
        gitExecutable: 'git',
        npmExecutable: 'npm',
      }),
      files,
      validator,
      clock,
      node_version: settings.nodeVersion,
    }),
  ];
  return { commands, clock, validator, resolvePath: (path: string): string => resolve(settings.cwd, path) };
}

function admitCommands(
  settings: CompositionSettings,
  env: Readonly<Record<string, string>>,
  validator: RecordValidator,
): readonly CliCommand[] {
  const inputs = new NodeInputFileReader();
  const admit = createAwsExecutionAdmitter({
    studyRoot: settings.studyRoot,
    tempRoot: settings.tempRoot,
    nodeVersion: settings.nodeVersion,
    nodeExecutable: settings.nodeExecutable,
    env,
    inputs,
    clock: { now: (): Date => new Date() },
    validator,
  });
  return [
    new AdmitCommand('TRANSPORT_PROBE', { admit, inputs }),
    new AdmitCommand('VARIANT_VALIDATION', { admit, inputs }),
    new AdmitCommand('RUN', { admit, inputs }),
  ];
}

function executeCommands(deps: ExecuteCommandDeps): readonly CliCommand[] {
  return [
    new ExecuteCommand('TRANSPORT_PROBE', deps),
    new ExecuteCommand('VARIANT_VALIDATION', deps),
    new ExecuteCommand('RUN', deps),
  ];
}

// Child processes get exactly the variables that are set.
function definedEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
