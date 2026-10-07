// Wiring only (design §15.4: excluded from the mutation targets): the execution runner of one
// admitted package bound to its production adapters (design §10.2 P1-P9):
// - lease: the session lease over the guarded DynamoDB lease store of the frozen coordination table;
// - P2: CMP-05's provisioner over CMP-02's frozen-assembly provisioner, latching what it deployed;
// - P3: CMP-01's event-source-mapping control;
// - P4: CMP-04's trial executor (SQS publisher, warm-up Invoke) or probe executor (workload
//   Invoke), the SQS counters, DLQ receiver and Durable reader, and CMP-03's telemetry probe;
// - P7: CMP-01's cleanup adapters bound to the discovery targets of the frozen manifest, the
//   control-table barrier release and the leak auditor over the same surfaces;
// - P9: the summary writer of the execution's kind, under the safety limits of its kind.
// Adapters that need deployed names are deferred until P2 latched them (`deferred-ports.ts`).

import { join } from 'node:path';

import { AwsResourceDeleter } from '../../cleanup/aws/aws-resource-deleter.ts';
import { bindAwsCleanupPorts } from '../../cleanup/aws/aws-cleanup-bindings.ts';
import { createCleanupAwsClients } from '../../cleanup/aws/cleanup-aws-clients.ts';
import type { CleanupAwsClients } from '../../cleanup/aws/cleanup-aws-clients.ts';
import { CloudFormationStackApi } from '../../cleanup/aws/cloudformation-stack-api.ts';
import { LambdaConsumerControl } from '../../cleanup/aws/lambda-consumer-control.ts';
import { ControlTableBarrierRelease } from '../../cleanup/control-barrier-release.ts';
import { LeakAuditor } from '../../cleanup/leak-auditor.ts';
import { createDurableLeaseStore } from '../../coordination-lease/durable-lease-store.ts';
import { guardLeaseStore } from '../../coordination-lease/guarded-lease-store.ts';
import { createPostDeployClients, createPostDeployReader } from '../../deployment-assembly/aws/post-deploy-readers.ts';
import { CdkAssemblyDeployer } from '../../deployment-assembly/cdk-assembly-deployer.ts';
import { FrozenAssemblyProvisioner } from '../../deployment-assembly/frozen-assembly-provisioner.ts';
import { ChildProcessCommandRunner } from '../../deployment-assembly/node/child-process-command-runner.ts';
import { NodeAssemblyFileSystem } from '../../deployment-assembly/node/node-assembly-file-system.ts';
import type { DurableItemStore } from '../../durable-store/item-store-port.ts';
import type { StoreTableNames } from '../../durable-store/dynamodb-requests.ts';
import { createAwsTelemetryProbe, createTelemetryClients } from '../../evidence-collection/aws/aws-telemetry-probe.ts';
import {
  createCollectorLambdaClient,
  createLambdaDurableExecutionReader,
} from '../../evidence-collection/aws/durable-execution-reader.ts';
import {
  createCollectorSqsClient,
  createSqsDlqReceiver,
  createSqsQueueCounterReader,
} from '../../evidence-collection/aws/sqs-collector.ts';
import { NodePackageFileSystem } from '../../evidence-package/node/node-package-file-system.ts';
import { executionIdOf } from '../../evidence-package/package-layout.ts';
import { ExecutionRunner } from '../../execution-lifecycle/execution-runner.ts';
import type { ExecutionRunnerDeps } from '../../execution-lifecycle/execution-runner.ts';
import { FrozenAssemblyExecutionProvisioner } from '../../execution-lifecycle/execution-provisioner.ts';
import type {
  AdmittedExecution,
  CleanupBindings,
  ExecutionEvidenceReaders,
  ExecutionSafetyFactory,
  ExecutionServices,
} from '../../execution-lifecycle/execution-ports.ts';
import { ExecutorProbeRunner } from '../../execution-lifecycle/probe-runner.ts';
import { SessionExecutionLease } from '../../execution-lifecycle/session-lease.ts';
import { summaryWriterFor } from '../../execution-lifecycle/summary-writers.ts';
import {
  createKeepAliveHttpHandler,
  createProviderLambdaClient,
} from '../../provider-client/aws/provider-lambda-client.ts';
import { ok } from '../../record-contract/primitives.ts';
import { safetyLimitsFor } from '../../safety/safety-limits.ts';
import { SafetySupervisor } from '../../safety/safety-supervisor.ts';
import { createLambdaProbeWorkloadInvoker } from '../../trial-execution/aws/lambda-probe-workload-invoker.ts';
import { createLambdaProviderWarmupInvoker } from '../../trial-execution/aws/lambda-provider-warmup-invoker.ts';
import { createSqsTrialMessagePublisher } from '../../trial-execution/aws/sqs-trial-message-publisher.ts';
import { TrialExecutor } from '../../trial-execution/trial-executor.ts';
import type { DeferredExecutionPorts } from '../deferred-ports.ts';
import { deferredExecutionPorts } from '../deferred-ports.ts';
import {
  DeploymentLatch,
  LatchingProvisioner,
  StartRecordingProbeRunner,
  StartRecordingTrialRunner,
  UnitStartRegistry,
} from '../deployment-latch.ts';
import type { ExecutionSessionFactory } from '../execute-commands.ts';
import { executionTables } from '../execution-tables.ts';
import { EvidenceJournalFile } from '../node/evidence-journal-file.ts';
import { processScheduler, processServices } from '../node/process-services.ts';
import { awsCdkTools } from './aws-cdk-tools.ts';
import type { AwsCompositionSettings } from './aws-cdk-tools.ts';
import { createBoundedItemStore } from './aws-execution-store.ts';

/**
 * The runner of each admitted package over AWS.
 *
 * @example
 * const sessions = createAwsExecutionSessions(settings);
 * const session = sessions(admitted, '/study-1/evidence');
 */
export function createAwsExecutionSessions(settings: AwsCompositionSettings): ExecutionSessionFactory {
  return (admitted, evidenceRoot) => {
    const tables = executionTables(admitted);
    return tables.ok
      ? ok(new ExecutionRunner(admitted, runnerDeps(settings, admitted, evidenceRoot, tables.value)))
      : tables;
  };
}

function runnerDeps(
  settings: AwsCompositionSettings,
  admitted: AdmittedExecution,
  evidenceRoot: string,
  tables: StoreTableNames,
): ExecutionRunnerDeps {
  const services = processServices(settings.validator);
  const files = new NodePackageFileSystem(evidenceRoot);
  const journals = new EvidenceJournalFile(evidenceRoot);
  const store = createBoundedItemStore(tables);
  const latch = new DeploymentLatch();
  const starts = new UnitStartRegistry(services.clock);
  const cleanupClients = createCleanupAwsClients();
  const deferred = deferredPorts(admitted, latch, starts, cleanupClients, services);
  const sqs = createCollectorSqsClient();
  const readers: ExecutionEvidenceReaders = {
    store,
    queues: createSqsQueueCounterReader(sqs),
    durable: createLambdaDurableExecutionReader(createCollectorLambdaClient()),
    dlq: createSqsDlqReceiver(sqs),
  };
  const unit = {
    store,
    files,
    runner_journal: journals,
    ...pick(services),
    telemetry: deferred.telemetry,
    warmup: deferred.warmup,
  };
  const trials = new TrialExecutor({
    ...unit,
    queues: readers.queues,
    dlq: readers.dlq,
    durable: readers.durable,
    publisher: createSqsTrialMessagePublisher(sqs),
    log: (line): void => {
      services.log({ level: line.level, event: line.event, detail: `trial ${line.trial_id}: ${line.detail}` });
    },
  });
  const probe = new ExecutorProbeRunner({
    ...unit,
    workload: deferred.workload,
    log: (line): void => {
      services.log({
        level: line.level,
        event: line.event,
        detail: `probe ${line.transport_probe_id}: ${line.detail}`,
      });
    },
  });
  return {
    lease: new SessionExecutionLease(admitted, {
      store: guardLeaseStore(createDurableLeaseStore(store)),
      journals,
      scheduler: processScheduler(),
      services,
    }),
    provisioner: new LatchingProvisioner(provisionerOf(settings, files, journals, evidenceRoot, services), latch),
    readiness: { consumers: new LambdaConsumerControl(cleanupClients.lambda) },
    trials: new StartRecordingTrialRunner(trials, starts),
    probe: new StartRecordingProbeRunner(probe, starts),
    safety: safetyFactory(services),
    cleanup: cleanupBindings(cleanupClients, store, deferred, services),
    readers,
    evidence: { files, journals },
    summary: summaryWriterFor(admitted.identity.execution_kind, settings.validator),
    services,
  };
}

function deferredPorts(
  admitted: AdmittedExecution,
  latch: DeploymentLatch,
  starts: UnitStartRegistry,
  cleanupClients: CleanupAwsClients,
  services: ExecutionServices,
): DeferredExecutionPorts {
  const lambda = createProviderLambdaClient(createKeepAliveHttpHandler);
  const telemetryClients = createTelemetryClients();
  const trialVariants = new Map(admitted.manifest.trials.map((trial) => [trial.trial_id, trial.variant_id]));
  return deferredExecutionPorts(latch, admitted.identity, {
    warmup: (target) => createLambdaProviderWarmupInvoker(lambda, target),
    workload: (caller) => createLambdaProbeWorkloadInvoker(lambda, caller),
    telemetry: (functionNames) =>
      createAwsTelemetryProbe({
        clients: telemetryClients,
        binding: {
          execution_id: executionIdOf(admitted.identity),
          function_names: functionNames,
          trial_variants: trialVariants,
          unit_started_at: starts.view(),
        },
        clock: services.clock,
      }),
    cleanup: (targets) => {
      const bound = bindAwsCleanupPorts(cleanupClients, targets);
      return { durableExecutions: bound.durableExecutions, dlq: bound.dlq, surfaces: bound.surfaces };
    },
  });
}

function provisionerOf(
  settings: AwsCompositionSettings,
  files: NodePackageFileSystem,
  journals: EvidenceJournalFile,
  evidenceRoot: string,
  services: ExecutionServices,
): FrozenAssemblyExecutionProvisioner {
  const assemblyFiles = new NodeAssemblyFileSystem();
  return new FrozenAssemblyExecutionProvisioner(
    new FrozenAssemblyProvisioner({
      assembly_files: assemblyFiles,
      package_files: files,
      journal_file: journals,
      deployer: new CdkAssemblyDeployer({
        runner: new ChildProcessCommandRunner(),
        files: assemblyFiles,
        tools: awsCdkTools(settings),
        clock: services.clock,
      }),
      reader: createPostDeployReader(createPostDeployClients()),
      validator: services.validator,
      clock: services.clock,
      ids: services.ids,
      evidence_root: evidenceRoot,
      deploy_staging_root: join(settings.studyRoot, '.deploy-staging'),
    }),
  );
}

function safetyFactory(services: ExecutionServices): ExecutionSafetyFactory {
  return (startedNs, admitted) =>
    new SafetySupervisor({
      monotonic: services.monotonic,
      wall: services.clock,
      limits: safetyLimitsFor(admitted.identity.execution_kind),
      startedNs,
    });
}

/**
 * Cleanup's bindings: CMP-01's adapters, the deferred ones bound to the frozen manifest's targets,
 * the control-table barrier release and the leak auditor over the same discovery surfaces.
 *
 * @example
 * cleanupBindings(createCleanupAwsClients(), store, deferred, services);
 */
export function cleanupBindings(
  clients: CleanupAwsClients,
  store: DurableItemStore,
  targeted: Pick<DeferredExecutionPorts, 'durableExecutions' | 'dlq' | 'surfaces'>,
  services: ExecutionServices,
): CleanupBindings {
  return {
    consumers: new LambdaConsumerControl(clients.lambda),
    barriers: new ControlTableBarrierRelease(store),
    durableExecutions: targeted.durableExecutions,
    dlq: targeted.dlq,
    stacks: new CloudFormationStackApi(clients.cloudformation),
    surfaces: targeted.surfaces,
    deleter: new AwsResourceDeleter(clients),
    sleeper: services.sleeper,
    auditor: new LeakAuditor({
      surfaces: targeted.surfaces,
      clock: services.clock,
      monotonic: services.monotonic,
      sleeper: services.sleeper,
    }),
  };
}

function pick(services: ExecutionServices): Pick<ExecutionServices, 'clock' | 'sleeper' | 'ids' | 'validator'> {
  return { clock: services.clock, sleeper: services.sleeper, ids: services.ids, validator: services.validator };
}
