// Wiring only (design §15.4: excluded from the mutation targets): admission bound to its production
// ports. The cloud reads are admission's own read-only AWS readers (STS, Lambda account settings,
// CloudFormation `CDKToolkit`, DynamoDB `DescribeTable`) and the lease store's strongly consistent
// read of the table the environment input names; the local reads are git, the toolchain, the
// golden suite at HEAD, the schema catalogue, the stored probe packages and the transport scope of
// the committed source; synthesis is the real `cdk synth` with Docker forbidden. Nothing here
// mutates the cloud: admission's only writes are local (the attempt, the rejection, the package's
// `admission/`).

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AdmissionPorts, AdmissionRequest, AdmissionOutcome } from '../../admission/admission-ports.ts';
import {
  createAccountSettingsReader,
  createAdmissionClients,
  createBootstrapStackReader,
  createCallerIdentityReader,
  createCoordinationTableReader,
} from '../../admission/aws/admission-aws-readers.ts';
import { admitExecution } from '../../admission/admit-execution.ts';
import { GitSourceStateReader } from '../../admission/node/git-source-state-reader.ts';
import { GoldenSuiteReader } from '../../admission/node/golden-suite-reader.ts';
import { SchemaCatalogReader } from '../../admission/node/schema-catalog-reader.ts';
import { ToolchainReader } from '../../admission/node/toolchain-reader.ts';
import { StoredProbePackageReader } from '../../admission/stored-probe-package-reader.ts';
import { createDurableLeaseStore } from '../../coordination-lease/durable-lease-store.ts';
import { CdkAssemblySynthesizer } from '../../deployment-assembly/cdk-assembly-synthesizer.ts';
import { ChildProcessCommandRunner } from '../../deployment-assembly/node/child-process-command-runner.ts';
import { NodeAssemblyFileSystem } from '../../deployment-assembly/node/node-assembly-file-system.ts';
import { createStoreDynamoDbClient } from '../../durable-store/aws/dynamodb-client.ts';
import { createDynamoDbItemStore } from '../../durable-store/aws/dynamodb-item-store.ts';
import { NodeAppendOnlyFile } from '../../event-journal/node/node-append-only-file.ts';
import { NodePackageFileSystem } from '../../evidence-package/node/node-package-file-system.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';
import type { Uuid4, WallClock } from '../../record-contract/primitives.ts';
import { EsbuildBundleInputResolver } from '../../transport-qualification/scope/node/esbuild-bundle-input-resolver.ts';
import { GitCommittedSourceReader } from '../../transport-qualification/scope/node/git-committed-source-reader.ts';
import { NodeModulesPackageReader } from '../../transport-qualification/scope/node/node-modules-package-reader.ts';
import type { ExecutionAdmitter, InputFileReader } from '../admit-commands.ts';
import { EnvironmentLeaseReader } from '../environment-lease-reader.ts';

export interface AwsAdmitterSettings {
  /** Absolute path of `study-1/`; its parent is the repository root. */
  readonly studyRoot: string;
  readonly tempRoot: string;
  readonly nodeVersion: string;
  readonly nodeExecutable: string;
  readonly env: Readonly<Record<string, string>>;
  readonly inputs: InputFileReader;
  readonly clock: WallClock;
  readonly validator: RecordValidator;
}

/**
 * Admission over the production ports.
 *
 * @example
 * const admit = createAwsExecutionAdmitter(settings);
 * await admit(request, '/repo/study-1/evidence');
 */
export function createAwsExecutionAdmitter(settings: AwsAdmitterSettings): ExecutionAdmitter {
  return (request: AdmissionRequest, evidenceRoot: string): Promise<AdmissionOutcome> =>
    admitExecution(request, admissionPorts(settings, request, evidenceRoot));
}

function admissionPorts(
  settings: AwsAdmitterSettings,
  request: AdmissionRequest,
  evidenceRoot: string,
): AdmissionPorts {
  const { studyRoot, validator, clock } = settings;
  const clients = createAdmissionClients();
  const runner = new ChildProcessCommandRunner();
  const files = new NodeAssemblyFileSystem();
  const reportDirectory = mkdtempSync(join(settings.tempRoot, 'rua-admission-golden-'));
  return {
    git: new GitSourceStateReader({ repositoryRoot: dirname(studyRoot), lockfilePath: 'study-1/package-lock.json' }),
    toolchain: new ToolchainReader({ studyRoot, nodeVersion: settings.nodeVersion }),
    sts: createCallerIdentityReader(clients.sts),
    lambdaAccount: createAccountSettingsReader(clients.lambda),
    bootstrap: createBootstrapStackReader(clients.cloudformation),
    coordination: createCoordinationTableReader(clients.dynamodb),
    lease: new EnvironmentLeaseReader({
      inputs: settings.inputs,
      environmentPath: request.environment_input_path,
      validator,
      openLease: (tableName) =>
        createDurableLeaseStore(createDynamoDbItemStore({ coordination: tableName }, createStoreDynamoDbClient())),
    }),
    packages: new StoredProbePackageReader(new NodePackageFileSystem(evidenceRoot), clock),
    goldenSuite: new GoldenSuiteReader({
      runner,
      studyRoot,
      reportPath: join(reportDirectory, 'golden-report.json'),
      npmExecutable: 'npm',
      env: settings.env,
    }),
    schemas: new SchemaCatalogReader(),
    synthesizer: new CdkAssemblySynthesizer({
      runner,
      files,
      tools: {
        node_executable: settings.nodeExecutable,
        cdk_cli_entry: join(studyRoot, 'node_modules', 'aws-cdk', 'bin', 'cdk'),
        study_root: studyRoot,
        docker_sentinel: join(studyRoot, 'tools', 'docker-forbidden.sh'),
        environment: settings.env,
      },
    }),
    scope: {
      sources: new GitCommittedSourceReader({ projectRoot: studyRoot }),
      bundles: new EsbuildBundleInputResolver({ projectRoot: studyRoot }),
      installed: new NodeModulesPackageReader({ projectRoot: studyRoot }),
      validator,
    },
    files,
    journal: new NodeAppendOnlyFile(),
    clock,
    ids: { next: (): Uuid4 => randomUUID() as Uuid4 },
    validator,
    paths: { evidence_root: evidenceRoot, staging_root: join(studyRoot, '.deploy-staging') },
  };
}
