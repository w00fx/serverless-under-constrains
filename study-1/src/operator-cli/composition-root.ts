// Wiring only (design §15.4: excluded from the mutation targets): binds every operator command to
// its production adapters. Decisions live in the command modules and the features they call;
// this file only constructs objects.

import { resolve } from 'node:path';

import { ChildProcessCommandRunner } from '../deployment-assembly/node/child-process-command-runner.ts';
import { NodePackageFileSystem } from '../evidence-package/node/node-package-file-system.ts';
import { createRecordValidator } from '../record-contract/schema-registry.ts';
import type { CliCommand, CompositionRoot } from './cli-types.ts';
import { GitRevisionWorkspace } from './node/git-revision-workspace.ts';
import { OracleEvaluateCommand } from './oracle-evaluate-command.ts';
import { OracleRevisionCheckCommand } from './oracle-revision-check.ts';
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
}

/**
 * The production composition of every operator command.
 *
 * @example
 * const root = createCompositionRoot({ studyRoot, cwd: process.cwd(), env: process.env, tempRoot: tmpdir(), nodeVersion: process.version });
 */
export function createCompositionRoot(settings: CompositionSettings): CompositionRoot {
  const validator = createRecordValidator();
  const clock = { now: (): Date => new Date() };
  const env = definedEnvironment(settings.env);
  const runner = new ChildProcessCommandRunner();
  const files = (evidenceRoot: string): NodePackageFileSystem => new NodePackageFileSystem(evidenceRoot);
  const commands: readonly CliCommand[] = [
    new OracleRevisionCheckCommand({
      workspace: new GitRevisionWorkspace({
        runner,
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
    new OracleEvaluateCommand({ files, validator, clock }),
    new ProbeVerifyCommand({ files, validator, clock }),
    new ValidationVerifyCommand({ files, validator, clock }),
    new RunVerifyCommand({ files, validator, clock, qualifications: new StoredQualificationReader(clock, validator) }),
  ];
  return { commands, clock, validator, resolvePath: (path: string): string => resolve(settings.cwd, path) };
}

// Child processes get exactly the variables that are set.
function definedEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
