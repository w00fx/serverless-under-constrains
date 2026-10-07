// Wiring only (design §15.4: excluded from the mutation targets): the coordination commands over
// AWS. `bootstrap` runs CMP-02's `CoordinationBaselineDeployer` in a fresh work directory below
// `<study>/.deploy-staging/coordination/` (ignored like every deploy copy); `verify` reads step A8's inputs read-only: admission's own
// DescribeTable/DescribeTimeToLive reader and the guarded lease store's strongly consistent read.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { createAdmissionClients, createCoordinationTableReader } from '../../admission/aws/admission-aws-readers.ts';
import { createDurableLeaseStore } from '../../coordination-lease/durable-lease-store.ts';
import { guardLeaseStore } from '../../coordination-lease/guarded-lease-store.ts';
import { CoordinationBaselineDeployer } from '../../deployment-assembly/coordination-baseline.ts';
import { ChildProcessCommandRunner } from '../../deployment-assembly/node/child-process-command-runner.ts';
import { NodeAssemblyFileSystem } from '../../deployment-assembly/node/node-assembly-file-system.ts';
import type { WallClock } from '../../record-contract/primitives.ts';
import type { CoordinationDeploy, CoordinationReader } from '../coordination-commands.ts';
import { coordinationTableName } from '../environment-lease-reader.ts';
import { awsCdkTools } from './aws-cdk-tools.ts';
import type { AwsCompositionSettings } from './aws-cdk-tools.ts';
import { createBoundedItemStore } from './aws-execution-store.ts';

/**
 * `coordination bootstrap` over AWS.
 *
 * @example
 * new CoordinationBootstrapCommand(createAwsCoordinationDeploy(settings, clock));
 */
export function createAwsCoordinationDeploy(settings: AwsCompositionSettings, clock: WallClock): CoordinationDeploy {
  return () =>
    new CoordinationBaselineDeployer({
      runner: new ChildProcessCommandRunner(),
      files: new NodeAssemblyFileSystem(),
      tools: awsCdkTools(settings),
      clock,
    }).deploy(join(settings.studyRoot, '.deploy-staging', 'coordination', randomUUID()));
}

/**
 * `coordination verify` over AWS, read-only.
 *
 * @example
 * new CoordinationVerifyCommand({ inputs, validator, read: createAwsCoordinationReader() });
 */
export function createAwsCoordinationReader(): CoordinationReader {
  return async (environment) => {
    const arn = environment.coordination_table_arn;
    const table = await createCoordinationTableReader(createAdmissionClients().dynamodb).readCoordinationTable(arn);
    const name = coordinationTableName(arn);
    const lease = name.ok
      ? await guardLeaseStore(createDurableLeaseStore(createBoundedItemStore({ coordination: name.value }))).read()
      : name;
    return { table, lease };
  };
}
