// The offline cloud of a transport probe (design §12.2, §12.3; BR-RUA-027): the golden probe
// execution, admitted and provisioned, with the real provider and treatment controller
// (offline-transport.ts) and the real probe caller behind the emulated Invoke of its published
// version (OfflineProbeCaller), over the InMemoryItemStore emulator on one virtual clock. The real
// ProbeWorkloadExecutor runs the probe workload against it through the warm-up Invoke, the
// telemetry probe, the coordination checkpointer and an evidence root that holds the package and
// the runner and coordination journals.
//
// Time moves only in `finish`/`advanceUntil`: each step lets every continuation settle and advances
// the clock one second, so the probe's observation runs in milliseconds and reproducibly.

import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import { createJsonlJournalPort } from '../../../src/event-journal/jsonl-journal-port.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import type { ExecutionManifest } from '../../../src/record-contract/records/group-a/execution_manifest.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { composeProbeCaller } from '../../../src/transport-probe-caller/probe-caller-composition.ts';
import { writeExecutionConfiguration } from '../../../src/trial-execution/execution-configuration.ts';
import { ProbeWorkloadExecutor } from '../../../src/trial-execution/probe-workload-executor.ts';
import { planProbeWorkload } from '../../../src/trial-execution/probe-workload-plan.ts';
import type {
  ProbeExecution,
  ProbeExecutionLogLine,
  ProbeExecutionReport,
  ProbeWorkloadPlan,
} from '../../../src/trial-execution/trial-execution-ports.ts';
import { InMemoryItemStore } from '../durable-store/in-memory-item-store.ts';
import type { StreamFeed } from '../durable-store/stream-feed.ts';
import { EXECUTION_MANIFEST_PATH } from '../golden-builder/trial-context.ts';
import { executionContextOf, EXECUTION_OFFSETS } from '../golden-builder/execution-files.ts';
import { GOLDEN_CALLER_VERSION, GOLDEN_PROVIDER_VERSION, TIMELINE_ORIGIN_MS } from '../golden-builder/golden-values.ts';
import { SequentialUuidSource } from '../kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';
import { OFFLINE_MAX_STEPS, OFFLINE_STEP_MS } from './offline-cloud.ts';
import { OfflineCoordinationCheckpointer } from './offline-coordination-checkpointer.ts';
import { frozenCoreFiles } from './offline-execution.ts';
import type { FrozenCoreFiles } from './offline-execution.ts';
import { OfflinePackageStorage } from './offline-package-storage.ts';
import { OfflineProbeCaller } from './offline-probe-caller.ts';
import { OfflineProviderWarmupInvoker } from './offline-provider-warmup-invoker.ts';
import { OfflineTelemetryProbe } from './offline-telemetry-probe.ts';
import { composeOfflineTransport } from './offline-transport.ts';
import { ScriptedPublicationGate } from './scripted-publication-gate.ts';

/** The probe caller version the emulated Invoke reports (stack output `ProbeCallerVersion`). */
export const OFFLINE_PROBE_CALLER_VERSION = GOLDEN_CALLER_VERSION;

/** A probe the executor is running; `report` settles when it is frozen or refused. */
export interface RunningProbe {
  readonly plan: ProbeWorkloadPlan;
  readonly report: Promise<ProbeExecutionReport>;
  isSettled(): boolean;
}

/** How the probe's execution starts: with or without the A-09 item, and core files left out. */
export interface OfflineProbeStart {
  readonly withExecutionConfiguration?: boolean;
  /** Core files admission is made to leave out, such as the execution manifest. */
  readonly omitCoreFiles?: readonly string[];
}

export class OfflineProbeCloud {
  readonly identity: ProbeExecution;
  readonly frozen: FrozenCoreFiles;
  readonly package_directory: string;
  readonly time = new VirtualTimeScheduler({
    wallEpochMs: TIMELINE_ORIGIN_MS + EXECUTION_OFFSETS.trials_started,
    monotonicOriginNs: 5_000_000_000n,
  });
  readonly store = new InMemoryItemStore({ clock: this.time });
  readonly storage = new OfflinePackageStorage();
  readonly gate = new ScriptedPublicationGate();
  readonly logs: ProbeExecutionLogLine[] = [];
  readonly warmup: OfflineProviderWarmupInvoker;
  readonly caller: OfflineProbeCaller;
  readonly telemetry: OfflineTelemetryProbe;
  readonly checkpoint: OfflineCoordinationCheckpointer;
  readonly executor: ProbeWorkloadExecutor;
  readonly #feed: StreamFeed;

  constructor() {
    const { time, store } = this;
    const context = executionContextOf('probe');
    this.identity = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: context.execution_id };
    this.frozen = frozenCoreFiles('probe');
    this.package_directory = PACKAGE_LAYOUT.executionDirectory(this.identity);
    const transport = composeOfflineTransport(this.identity, store, time);
    this.#feed = transport.feed;
    this.warmup = new OfflineProviderWarmupInvoker(transport.invoker);
    const probeCaller = composeProbeCaller({
      deployment: this.identity,
      provider_qualifier: GOLDEN_PROVIDER_VERSION,
      store,
      invoker: transport.invoker,
      ids: new SequentialUuidSource('eeeeeeee'),
      wall: time,
      monotonic: time,
      scheduler: time,
    });
    this.caller = new OfflineProbeCaller(
      probeCaller,
      OFFLINE_PROBE_CALLER_VERSION,
      new SequentialUuidSource('1a1a1a1a'),
    );
    this.telemetry = new OfflineTelemetryProbe(context.resource_prefix);
    this.checkpoint = new OfflineCoordinationCheckpointer(
      this.storage,
      {
        package_directory: this.package_directory,
        transport_probe_id: this.identity.transport_probe_id,
        execution_manifest_sha256: this.frozen.execution_manifest_sha256,
      },
      time,
    );
    this.executor = new ProbeWorkloadExecutor({
      store,
      telemetry: this.telemetry,
      warmup: this.warmup,
      workload: this.caller,
      checkpoint: this.checkpoint,
      files: this.storage,
      runner_journal: this.storage,
      clock: time,
      sleeper: time,
      ids: new SequentialUuidSource('77777777'),
      validator: createRecordValidator(),
      log: (line): void => {
        this.logs.push(line);
      },
    });
  }

  /**
   * What admission, the lease, provisioning and readiness leave behind (design §10.2 P1-P3): the
   * frozen core files, the coordination journal the lease is still appending to, the execution
   * configuration item (A-09) and an enabled controller stream mapping.
   *
   * @example
   * const cloud = new OfflineProbeCloud();
   * await cloud.startExecution();
   */
  async startExecution(options: OfflineProbeStart = {}): Promise<void> {
    const omitted = new Set(options.omitCoreFiles ?? []);
    for (const [path, bytes] of [...this.frozen.core_files].filter(([candidate]) => !omitted.has(candidate))) {
      const written = await this.storage.writeOnce(`${this.package_directory}/${path}`, bytes);
      if (!written.ok) {
        throw new Error(`core file ${path} was not written (${written.error.code}); expected a fresh evidence root`);
      }
    }
    await this.#acquireLease();
    if (options.withExecutionConfiguration !== false) {
      const configured = await writeExecutionConfiguration(
        this.store,
        { execution: this.identity, execution_manifest_sha256: this.frozen.execution_manifest_sha256 },
        this.time,
      );
      if (!configured.ok) {
        throw new Error(`${configured.error.detail}; expected a fresh control table`);
      }
    }
    this.#feed.enable();
  }

  /** The probe's workload plan, from the frozen manifest and the golden published versions. */
  plan(): ProbeWorkloadPlan {
    const bytes = this.frozen.core_files.get(EXECUTION_MANIFEST_PATH) ?? new Uint8Array();
    const manifest = parseJsonDocument(bytes);
    if (!manifest.ok) {
      throw new Error(`the probe manifest is not JSON (${manifest.error.kind}); expected the golden manifest`);
    }
    const planned = planProbeWorkload(
      manifest.value as unknown as ExecutionManifest,
      this.frozen.execution_manifest_sha256,
      { provider_version: GOLDEN_PROVIDER_VERSION, probe_caller_version: OFFLINE_PROBE_CALLER_VERSION },
    );
    if (!planned.ok) {
      throw new Error(`${planned.error.detail}; expected the golden probe to plan`);
    }
    return planned.value;
  }

  /** Starts the executor on `plan` without driving time. */
  start(plan: ProbeWorkloadPlan = this.plan()): RunningProbe {
    const progress = { settled: false };
    const report = this.executor.execute(plan, this.gate).finally(() => {
      progress.settled = true;
    });
    report.catch(() => undefined);
    return { plan, report, isSettled: () => progress.settled };
  }

  /** Drives until `reached()` holds; throws when it does not within OFFLINE_MAX_STEPS. */
  async advanceUntil(reached: () => boolean): Promise<void> {
    for (let step = 0; step < OFFLINE_MAX_STEPS && !reached(); step += 1) {
      await this.#step();
    }
    if (!reached()) {
      throw new Error(`the awaited condition did not hold in ${String(OFFLINE_MAX_STEPS)} steps; expected it to`);
    }
  }

  /** Drives until the probe's report settles. */
  async finish(running: RunningProbe): Promise<ProbeExecutionReport> {
    await this.advanceUntil(() => running.isSettled());
    return running.report;
  }

  /** Runs the probe workload to its report. */
  runProbe(): Promise<ProbeExecutionReport> {
    return this.finish(this.start());
  }

  /** The package path of the runner journal. */
  runnerJournalPath(): string {
    return `${this.package_directory}/${EXECUTION_PATHS.runnerJournal}`;
  }

  /** The probe package's files, keyed by package-relative path. */
  packageFiles(): ReadonlyMap<string, Uint8Array> {
    return this.storage.filesUnder(this.package_directory);
  }

  // P1: the lease's first coordination event, so the journal the checkpoint reads has a prefix.
  async #acquireLease(): Promise<void> {
    const ids = new SequentialUuidSource('c0c0c0c0');
    const lease = new JournalWriter({
      port: createJsonlJournalPort(`${this.package_directory}/${EXECUTION_PATHS.coordinationJournal}`, this.storage),
      source: 'coordination_lease',
      instanceId: ids.next(),
      scope: {
        execution: this.identity,
        execution_manifest_sha256: this.frozen.execution_manifest_sha256,
        partition: { kind: 'execution' },
      },
      clock: this.time,
      ids,
      maxDefinitiveRetries: 0,
    });
    const acquired = await lease.append('lease_event_recorded', {
      lease_event: 'ACQUIRED',
      owner_kind: 'TRANSPORT_PROBE',
      owner_id: this.identity.transport_probe_id,
      owner_manifest_sha256: this.frozen.execution_manifest_sha256,
      lease_version: 1,
      lease_health: 'CONFIRMED',
    });
    if (acquired.kind !== 'appended') {
      throw new Error(
        `lease_event_recorded was not appended (${acquired.reason}); expected a fresh coordination journal`,
      );
    }
  }

  async #step(): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await this.time.advanceBy(OFFLINE_STEP_MS);
  }
}
