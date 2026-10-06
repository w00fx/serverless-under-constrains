// One offline transport probe end to end (design §10.2 P1-P9 for the probe, §12.2): the offline
// probe cloud's golden probe with its real provider, controller and probe caller, the real
// `ProbeWorkloadExecutor` behind the runner's ProbeRunner binding, the account its cleanup acts on,
// the offline provisioner and the execution runner over all of them, on one virtual clock. The
// deploy freezes the golden probe resource manifest with the probe caller's stack outputs added
// (the golden one names only the provider qualifier), so the runner plans the probe from the
// targets the frozen manifest names, as a real deploy would.

import { readAdmittedExecution } from '../../../../src/execution-lifecycle/admitted-execution.ts';
import { ExecutionRunner } from '../../../../src/execution-lifecycle/execution-runner.ts';
import type { ExecutionRunnerDeps } from '../../../../src/execution-lifecycle/execution-runner.ts';
import type {
  AdmittedExecution,
  ExecutionLogLine,
  ExecutionOutcome,
  ExecutionServices,
  ExecutionTargets,
} from '../../../../src/execution-lifecycle/execution-ports.ts';
import { STACK_OUTPUT_KEYS, executionTargetsOf } from '../../../../src/execution-lifecycle/execution-targets.ts';
import { ExecutorProbeRunner } from '../../../../src/execution-lifecycle/probe-runner.ts';
import { TransportProbeSummaryWriter } from '../../../../src/execution-lifecycle/probe-summary-writer.ts';
import { EXECUTION_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../../src/record-contract/records/group-a/resource_manifest.ts';
import { PROBE_SAFETY } from '../../../../src/safety/safety-limits.ts';
import type { SafetyLimits } from '../../../../src/safety/safety-limits.ts';
import { SafetySupervisor } from '../../../../src/safety/safety-supervisor.ts';
import { ScriptedDurableExecutionReader } from '../../../support/evidence-collection/scripted-durable-execution-reader.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { OfflineDlqReceiver } from '../../../support/offline-cloud/offline-dlq-receiver.ts';
import { OfflineMessageLog } from '../../../support/offline-cloud/offline-message-log.ts';
import { OFFLINE_PROBE_CALLER_VERSION, OfflineProbeCloud } from '../../../support/offline-cloud/offline-probe-cloud.ts';
import { OfflineQueueCounterReader } from '../../../support/offline-cloud/offline-queue-counter-reader.ts';
import { OfflineProvisioner } from '../fakes/offline-provisioner.ts';
import { ScriptedExecutionLease } from '../fakes/scripted-execution-lease.ts';
import { ScriptedTrialRunner } from '../fakes/scripted-trial-runner.ts';
import { lifecycleServices, lifecycleValidator } from './execution-fixtures.ts';
import { cleanupBindings, offlineAccount } from './offline-account.ts';
import type { OfflineAccount } from './offline-account.ts';
import { driveUntilSettled } from './virtual-drive.ts';

/** What a test changes about the probe world. */
export interface ProbeWorldOptions {
  /** Safety limits of the real supervisor (the probe maximums by default). */
  readonly limits?: SafetyLimits;
  /** Replaces any runner dependency, given the world built so far. */
  readonly deps?: (world: ProbeRunnerWorld) => Partial<ExecutionRunnerDeps>;
}

/**
 * The admitted golden probe and the runner over it.
 *
 * @example
 * const world = await ProbeRunnerWorld.create();
 * const outcome = await world.run();
 */
export class ProbeRunnerWorld {
  readonly cloud: OfflineProbeCloud;
  readonly admitted: AdmittedExecution;
  readonly account: OfflineAccount;
  readonly targets: ExecutionTargets;
  readonly lease = new ScriptedExecutionLease();
  readonly logs: ExecutionLogLine[];
  readonly services: ExecutionServices;
  readonly deps: ExecutionRunnerDeps;
  readonly runner: ExecutionRunner;

  private constructor(cloud: OfflineProbeCloud, options: ProbeWorldOptions) {
    this.cloud = cloud;
    const manifestBytes = cloud.frozen.core_files.get(EXECUTION_PATHS.executionManifest) ?? new Uint8Array();
    const admitted = readAdmittedExecution(manifestBytes, lifecycleValidator());
    if (!admitted.ok) {
      throw new Error(`the golden probe manifest was not admitted (${admitted.error.code}); expected a probe`);
    }
    this.admitted = admitted.value;
    const resourceManifest = deployedProbeManifest(cloud);
    const targets = executionTargetsOf(resourceManifest);
    if (!targets.ok) {
      throw new Error(`${targets.error.detail}; expected the probe stack's targets`);
    }
    this.targets = targets.value;
    this.account = offlineAccount(resourceManifest);
    const { services, logs } = lifecycleServices(cloud.time);
    this.services = services;
    this.logs = logs;
    const limits = options.limits ?? PROBE_SAFETY;
    const base: ExecutionRunnerDeps = {
      lease: this.lease,
      provisioner: new OfflineProvisioner({
        bytes: serializeRecordFile(resourceManifest),
        targets: this.targets,
        log: this.account.log,
        files: cloud.storage,
      }),
      readiness: { consumers: this.account.consumers },
      trials: new ScriptedTrialRunner(),
      probe: new ExecutorProbeRunner({
        store: cloud.store,
        telemetry: cloud.telemetry,
        warmup: cloud.warmup,
        workload: cloud.caller,
        files: cloud.storage,
        runner_journal: cloud.storage,
        clock: cloud.time,
        sleeper: cloud.time,
        ids: new SequentialUuidSource('9a9a9a9a'),
        validator: lifecycleValidator(),
        log: (line): void => {
          cloud.logs.push(line);
        },
      }),
      safety: (startedNs) => new SafetySupervisor({ monotonic: cloud.time, wall: cloud.time, limits, startedNs }),
      cleanup: cleanupBindings(this.account, cloud.store, cloud.time),
      readers: {
        store: cloud.store,
        queues: new OfflineQueueCounterReader(new Map()),
        durable: new ScriptedDurableExecutionReader(),
        dlq: new OfflineDlqReceiver(new Map(), new OfflineMessageLog(cloud.time)),
      },
      evidence: { files: cloud.storage, journals: cloud.storage },
      summary: new TransportProbeSummaryWriter(lifecycleValidator()),
      services,
    };
    this.deps = { ...base, ...options.deps?.(this) };
    this.runner = new ExecutionRunner(this.admitted, this.deps);
  }

  /**
   * A probe whose package holds what admission froze (the resource manifest comes from the deploy),
   * with the coordination journal's acquisition line and the controller stream enabled.
   */
  static async create(options: ProbeWorldOptions = {}): Promise<ProbeRunnerWorld> {
    const cloud = new OfflineProbeCloud();
    await cloud.startExecution({
      withExecutionConfiguration: false,
      omitCoreFiles: [EXECUTION_PATHS.resourceManifest],
    });
    return new ProbeRunnerWorld(cloud, options);
  }

  /** Runs the probe through `runProbe`, driving virtual time until it settles. */
  run(): Promise<ExecutionOutcome> {
    return this.drive(this.runner.runProbe());
  }

  /** Drives the probe cloud a second at a time until `work` settles. */
  drive<T>(work: Promise<T>): Promise<T> {
    return driveUntilSettled(async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await this.cloud.time.advanceBy(1000);
    }, work);
  }

  /** The package file at a package-relative path, or undefined. */
  file(path: string): Uint8Array | undefined {
    return this.cloud.packageFiles().get(path);
  }

  /** The package file at `path` parsed as one JSON record; throws when absent. */
  record(path: string): JsonObject {
    const bytes = this.file(path);
    if (bytes === undefined) {
      throw new Error(`${path} is not in the package; expected it written`);
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as JsonObject;
  }

  /** The runner journal's phase transitions as `<phase>:<status>`, in order. */
  phases(): readonly string[] {
    const text = new TextDecoder().decode(this.file(EXECUTION_PATHS.runnerJournal) ?? new Uint8Array());
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as JsonObject)
      .filter((event) => event['record_type'] === 'phase_transition_recorded')
      .map((event) => `${JSON.stringify(event['phase'])}:${JSON.stringify(event['status'])}`.replaceAll('"', ''));
  }
}

// The golden probe resource manifest with the probe caller's stack outputs.
function deployedProbeManifest(cloud: OfflineProbeCloud): ResourceManifest {
  const bytes = cloud.frozen.core_files.get(EXECUTION_PATHS.resourceManifest) ?? new Uint8Array();
  const golden = JSON.parse(new TextDecoder().decode(bytes)) as ResourceManifest;
  const prefix = cloud.identity.transport_probe_id.slice(0, 8);
  return {
    ...golden,
    outputs: [
      ...golden.outputs,
      { key: STACK_OUTPUT_KEYS.probeCallerFunctionName, value: `suc1-${prefix}-probe-caller` },
      { key: STACK_OUTPUT_KEYS.probeCallerVersion, value: OFFLINE_PROBE_CALLER_VERSION },
    ],
  };
}
