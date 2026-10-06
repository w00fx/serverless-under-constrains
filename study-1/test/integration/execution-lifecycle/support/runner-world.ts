// One offline execution end to end (design §10.2 P1-P9, §12.2): the offline cloud's run or
// validation with its real provider, controller, consumer and trial executor, the account its
// cleanup acts on, the offline provisioner and the execution runner over all of them, on one
// virtual clock. `run()` drives the cloud a second at a time until the runner settles, so trials,
// readiness polls, the 120 s monitoring window and cleanup's waits all pass in virtual time.

import { ExecutionRunner } from '../../../../src/execution-lifecycle/execution-runner.ts';
import type { ExecutionRunnerDeps } from '../../../../src/execution-lifecycle/execution-runner.ts';
import { RunSummaryWriter } from '../../../../src/execution-lifecycle/execution-finalization.ts';
import type {
  AdmittedTrialExecution,
  ExecutionLogLine,
  ExecutionOutcome,
  ExecutionSafetyFactory,
  ExecutionServices,
  ExecutionTargets,
} from '../../../../src/execution-lifecycle/execution-ports.ts';
import { EXECUTION_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ResourceManifest } from '../../../../src/record-contract/records/group-a/resource_manifest.ts';
import { RUN_SAFETY } from '../../../../src/safety/safety-limits.ts';
import type { SafetyLimits } from '../../../../src/safety/safety-limits.ts';
import { SafetySupervisor } from '../../../../src/safety/safety-supervisor.ts';
import { OfflineCloud } from '../../../support/offline-cloud/offline-cloud.ts';
import type { OfflineExecutionName } from '../../../support/offline-cloud/offline-execution.ts';
import { OfflineProvisioner } from '../fakes/offline-provisioner.ts';
import { ScriptedExecutionLease } from '../fakes/scripted-execution-lease.ts';
import { ScriptedProbeRunner } from '../fakes/scripted-probe-runner.ts';
import { admittedOf, lifecycleServices, lifecycleValidator, targetsOf } from './execution-fixtures.ts';
import { cleanupBindings, offlineAccount } from './offline-account.ts';
import type { OfflineAccount } from './offline-account.ts';
import { driveUntilSettled } from './virtual-drive.ts';

/** What a test changes about the world. */
export interface RunnerWorldOptions {
  readonly name?: OfflineExecutionName;
  /** The deployed targets; `null` for a deploy that failed. */
  readonly targets?: ExecutionTargets | null;
  /** Safety limits of the real supervisor (the run maximums by default). */
  readonly limits?: SafetyLimits;
  /** Replaces any runner dependency, given the world built so far. */
  readonly deps?: (world: RunnerWorld) => Partial<ExecutionRunnerDeps>;
}

/**
 * An admitted offline execution and the runner over it.
 *
 * @example
 * const world = await RunnerWorld.create();
 * const outcome = await world.run();
 */
export class RunnerWorld {
  readonly cloud: OfflineCloud;
  readonly admitted: AdmittedTrialExecution;
  readonly account: OfflineAccount;
  /** The resource manifest bytes the deploy freezes (the offline cloud's golden manifest). */
  readonly resourceManifestBytes: Uint8Array;
  readonly lease = new ScriptedExecutionLease();
  /** The probe runner a trial execution never calls (a guard: a call fails the probe's P4). */
  readonly probe = new ScriptedProbeRunner();
  readonly provisioner: OfflineProvisioner;
  readonly logs: ExecutionLogLine[];
  readonly services: ExecutionServices;
  readonly runner: ExecutionRunner;
  readonly deps: ExecutionRunnerDeps;

  private constructor(cloud: OfflineCloud, options: RunnerWorldOptions) {
    this.cloud = cloud;
    const { execution } = cloud;
    this.admitted = admittedOf(execution);
    const bytes = execution.core_files.get(EXECUTION_PATHS.resourceManifest) ?? new Uint8Array();
    this.resourceManifestBytes = bytes;
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as ResourceManifest;
    this.account = offlineAccount(manifest);
    const targets = options.targets === undefined ? targetsOf(execution) : options.targets;
    this.provisioner = new OfflineProvisioner({
      bytes,
      ...(targets === null ? {} : { targets }),
      log: this.account.log,
    });
    const { services, logs } = lifecycleServices(cloud.time);
    this.logs = logs;
    this.services = services;
    const limits = options.limits ?? RUN_SAFETY;
    const safety: ExecutionSafetyFactory = (startedNs) =>
      new SafetySupervisor({ monotonic: cloud.time, wall: cloud.time, limits, startedNs });
    const base: ExecutionRunnerDeps = {
      lease: this.lease,
      provisioner: this.provisioner,
      readiness: { consumers: this.account.consumers },
      trials: cloud.executor,
      probe: this.probe,
      safety,
      cleanup: cleanupBindings(this.account, cloud.store, cloud.time),
      readers: { store: cloud.store, queues: cloud.counters, durable: cloud.durable, dlq: cloud.dlqReceiver },
      evidence: { files: cloud.storage, journals: cloud.storage },
      summary: new RunSummaryWriter(lifecycleValidator()),
      services,
    };
    this.deps = { ...base, ...options.deps?.(this) };
    this.runner = new ExecutionRunner(this.admitted, this.deps);
  }

  /**
   * A world whose package holds what admission froze (the provisioner adds nothing the offline
   * cloud's core files do not already carry), with the controller stream enabled.
   */
  static async create(options: RunnerWorldOptions = {}): Promise<RunnerWorld> {
    const cloud = new OfflineCloud(options.name ?? 'run');
    await cloud.startExecution({ withExecutionConfiguration: false });
    return new RunnerWorld(cloud, options);
  }

  /** Runs the execution, driving virtual time until it settles. */
  run(): Promise<ExecutionOutcome> {
    return this.drive(this.runner.run());
  }

  /** Drives the cloud a second at a time until `work` settles. */
  drive<T>(work: Promise<T>): Promise<T> {
    return driveUntilSettled(() => this.cloud.advanceBy(1000), work);
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

  /** The records of a JSONL journal of the package, in line order. */
  journal(path: string): readonly JsonObject[] {
    const text = new TextDecoder().decode(this.file(path) ?? new Uint8Array());
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as JsonObject);
  }

  /** The runner journal's events as `<record_type>[:<phase>:<status>]`, in order. */
  runnerEvents(): readonly string[] {
    return this.journal(EXECUTION_PATHS.runnerJournal).map((event) =>
      event['record_type'] === 'phase_transition_recorded'
        ? `${textOf(event['phase'])}:${textOf(event['status'])}`
        : textOf(event['record_type']),
    );
  }

  /**
   * Milliseconds from the lease acquisition (the deadline clock's start) to the first runner
   * event `matches` accepts; throws when none does.
   */
  elapsedMsAt(matches: (event: JsonObject) => boolean): number {
    const events = this.journal(EXECUTION_PATHS.runnerJournal);
    const found = events.find(matches);
    const origin = events[0];
    if (found === undefined || origin === undefined) {
      throw new Error('no runner event matched; expected the calibration run to journal it');
    }
    return Date.parse(textOf(found['occurred_at'])) - Date.parse(textOf(origin['occurred_at']));
  }
}

// A journal member as text: strings as they are, anything else (an absent member as `null`) as JSON.
function textOf(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}
