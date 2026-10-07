// Wiring only (design §15.4): where the pinned CDK CLI and the Docker sentinel live for this study,
// shared by every command that synthesizes or deploys (execution stacks and the coordination
// baseline), and the settings the AWS-bound commands are composed with.

import { join } from 'node:path';

import type { CdkToolSettings } from '../../deployment-assembly/cdk-invocations.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';

/** What every AWS-bound command is composed with. */
export interface AwsCompositionSettings {
  /** Absolute path of `study-1/`. */
  readonly studyRoot: string;
  /** The Node executable the CDK CLI runs under (`process.execPath`). */
  readonly nodeExecutable: string;
  /** The operator's environment, with only the variables that are set. */
  readonly env: Readonly<Record<string, string>>;
  readonly validator: RecordValidator;
}

/**
 * The pinned CDK tool settings of the study.
 *
 * @example
 * new CdkAssemblyDeployer({ runner, files, tools: awsCdkTools(settings), clock });
 */
export function awsCdkTools(settings: AwsCompositionSettings): CdkToolSettings {
  return {
    node_executable: settings.nodeExecutable,
    cdk_cli_entry: join(settings.studyRoot, 'node_modules', 'aws-cdk', 'bin', 'cdk'),
    study_root: settings.studyRoot,
    docker_sentinel: join(settings.studyRoot, 'tools', 'docker-forbidden.sh'),
    environment: settings.env,
  };
}
