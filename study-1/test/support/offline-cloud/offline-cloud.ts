// The offline cloud (design §12.2, §12.3): one admitted execution with the real provider,
// treatment controller and conventional consumer, over the InMemoryItemStore emulator, the
// StreamFeed of the caller journal, the in-process Lambda Invoke of the provider and the
// in-memory FIFO source with its DLQ, all on one virtual clock. The real TrialExecutor runs the
// declared trials against it through the offline SQS publisher, counter reader and DLQ receiver,
// the warm-up Invoke and an evidence root that holds the package and the runner journal.
//
// Time moves only in `advanceBy`/`finish`: each step lets the event source mapping start a poll,
// lets every continuation settle and advances the clock one second, so a trial's 600 s of
// observation run in milliseconds and every interleaving is reproducible. The Durable variant
// needs the Durable SDK's own test runner and real time (test/integration/durable-variant), so the
// offline cloud runs conventional trials only (evidence/WP-26/decisions.md).

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { composeConventionalConsumer } from '../../../src/conventional-variant/conventional-composition.ts';
import { consumeSqsEvent } from '../../../src/conventional-variant/sqs-event-consumption.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { composeRefundProvider } from '../../../src/refund-provider/provider-composition.ts';
import { composeTreatmentController } from '../../../src/treatment-controller/controller-composition.ts';
import { consumeStreamEvent } from '../../../src/treatment-controller/stream-consumer.ts';
import { CONTROLLER_STREAM_FILTER } from '../../../src/treatment-controller/stream-record.ts';
import { writeExecutionConfiguration } from '../../../src/trial-execution/execution-configuration.ts';
import { TrialExecutor } from '../../../src/trial-execution/trial-executor.ts';
import type {
  TrialExecutionLogLine,
  TrialExecutionReport,
  TrialPlan,
} from '../../../src/trial-execution/trial-execution-ports.ts';
import { InMemoryItemStore } from '../durable-store/in-memory-item-store.ts';
import { StreamFeed } from '../durable-store/stream-feed.ts';
import { FakeSqsEsmDriver } from '../fifo-queue/fake-sqs-esm-driver.ts';
import { InMemoryFifoQueue } from '../fifo-queue/in-memory-fifo-queue.ts';
import { ScriptedDurableExecutionReader } from '../evidence-collection/scripted-durable-execution-reader.ts';
import { GOLDEN_PROVIDER_VERSION, TIMELINE_ORIGIN_MS } from '../golden-builder/golden-values.ts';
import { EXECUTION_OFFSETS } from '../golden-builder/execution-files.ts';
import { SequentialUuidSource } from '../kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';
import { ProviderLogRecorder } from '../refund-provider/provider-log-recorder.ts';
import { ControllerLogRecorder } from '../transport-rehearsal/controller-log-recorder.ts';
import { InProcessProviderInvoker } from '../transport-rehearsal/in-process-provider-invoker.ts';
import { OfflineDlqReceiver } from './offline-dlq-receiver.ts';
import { OfflineEsmPump } from './offline-esm-pump.ts';
import { offlineExecution, offlineTrialPlan, queueTarget } from './offline-execution.ts';
import type { OfflineExecution, OfflineExecutionName } from './offline-execution.ts';
import { OfflineMessageLog } from './offline-message-log.ts';
import { OfflinePackageStorage } from './offline-package-storage.ts';
import { OfflineProviderWarmupInvoker } from './offline-provider-warmup-invoker.ts';
import { OfflineQueueCounterReader } from './offline-queue-counter-reader.ts';
import { OfflineTelemetryProbe } from './offline-telemetry-probe.ts';
import { OfflineTrialMessagePublisher } from './offline-trial-message-publisher.ts';
import { ScriptedPublicationGate } from './scripted-publication-gate.ts';

/** How far one drive step moves the clock. */
export const OFFLINE_STEP_MS = 1000;
/** A trial settles or reaches its deadline well within an hour of virtual time. */
export const OFFLINE_MAX_STEPS = 3600;
/** OR-RUA-002: the conventional source's visibility timeout and redrive count. */
export const CONVENTIONAL_VISIBILITY_TIMEOUT_MS = 60_000;
export const MAX_RECEIVE_COUNT = 2;
export const DURABLE_VISIBILITY_TIMEOUT_MS = 360_000;

/** A trial the executor is running; `report` settles when it is frozen or refused. */
export interface RunningTrial {
  readonly plan: TrialPlan;
  readonly report: Promise<TrialExecutionReport>;
  isSettled(): boolean;
}

export class OfflineCloud {
  readonly execution: OfflineExecution;
  readonly time = new VirtualTimeScheduler({
    wallEpochMs: TIMELINE_ORIGIN_MS + EXECUTION_OFFSETS.trials_started,
    monotonicOriginNs: 5_000_000_000n,
  });
  readonly store = new InMemoryItemStore({ clock: this.time });
  readonly storage = new OfflinePackageStorage();
  readonly messages = new OfflineMessageLog(this.time);
  readonly gate = new ScriptedPublicationGate();
  readonly logs: TrialExecutionLogLine[] = [];
  readonly invoker: InProcessProviderInvoker;
  readonly source: InMemoryFifoQueue;
  readonly dlq: InMemoryFifoQueue;
  /** The Durable variant's queues: published to and observed, never consumed offline. */
  readonly durableSource: InMemoryFifoQueue;
  readonly durableDlq: InMemoryFifoQueue;
  readonly durable = new ScriptedDurableExecutionReader();
  readonly pump: OfflineEsmPump;
  readonly publisher: OfflineTrialMessagePublisher;
  readonly counters: OfflineQueueCounterReader;
  readonly dlqReceiver: OfflineDlqReceiver;
  readonly warmup: OfflineProviderWarmupInvoker;
  readonly telemetry: OfflineTelemetryProbe;
  readonly executor: TrialExecutor;
  readonly #feed: StreamFeed;
  readonly #queueIds = new SequentialUuidSource('51515151');

  constructor(name: OfflineExecutionName = 'run') {
    const { time, store } = this;
    this.execution = offlineExecution(name);
    const deployment = this.execution.identity;
    const provider = composeRefundProvider({
      deployment,
      store,
      ids: new SequentialUuidSource('99999999'),
      wall: time,
      monotonic: time,
      sleeper: time,
      log: new ProviderLogRecorder().sink,
    });
    this.invoker = new InProcessProviderInvoker(provider, GOLDEN_PROVIDER_VERSION);
    const controller = composeTreatmentController({
      deployment,
      store,
      ids: new SequentialUuidSource('cccccccc'),
      wall: time,
    });
    const controllerLogs = new ControllerLogRecorder();
    this.#feed = new StreamFeed({
      source: store,
      table: 'caller_journal',
      scheduler: time,
      clock: time,
      consumer: (event): Promise<void> => consumeStreamEvent(event, controller, controllerLogs.sink),
      filters: [CONTROLLER_STREAM_FILTER],
    });
    this.dlq = new InMemoryFifoQueue({
      clock: time,
      ids: this.#queueIds,
      visibilityTimeoutMs: CONVENTIONAL_VISIBILITY_TIMEOUT_MS,
    });
    this.source = new InMemoryFifoQueue({
      clock: time,
      ids: this.#queueIds,
      visibilityTimeoutMs: CONVENTIONAL_VISIBILITY_TIMEOUT_MS,
      redrive: { maxReceiveCount: MAX_RECEIVE_COUNT, deadLetterQueue: this.dlq },
    });
    this.durableDlq = new InMemoryFifoQueue({
      clock: time,
      ids: this.#queueIds,
      visibilityTimeoutMs: DURABLE_VISIBILITY_TIMEOUT_MS,
    });
    this.durableSource = new InMemoryFifoQueue({
      clock: time,
      ids: this.#queueIds,
      visibilityTimeoutMs: DURABLE_VISIBILITY_TIMEOUT_MS,
      redrive: { maxReceiveCount: MAX_RECEIVE_COUNT, deadLetterQueue: this.durableDlq },
    });
    const consumer = composeConventionalConsumer({
      deployment,
      provider_qualifier: GOLDEN_PROVIDER_VERSION,
      store,
      invoker: this.invoker,
      ids: new SequentialUuidSource('dddddddd'),
      wall: time,
      monotonic: time,
      scheduler: time,
    });
    const sourceTarget = queueTarget(this.execution.context, 'conventional', 'source');
    const dlqTarget = queueTarget(this.execution.context, 'conventional', 'dlq');
    const driver = new FakeSqsEsmDriver({
      queue: this.source,
      invoke: (event, context): Promise<void> => consumeSqsEvent(consumer, event, context.awsRequestId),
      event_source_arn: `arn:aws:sqs:us-east-1:012345678901:${sourceTarget.queue_name}`,
    });
    this.pump = new OfflineEsmPump(driver, this.messages, time);
    const queues = new Map([
      [sourceTarget.queue_url, this.source],
      [dlqTarget.queue_url, this.dlq],
      [queueTarget(this.execution.context, 'durable', 'source').queue_url, this.durableSource],
      [queueTarget(this.execution.context, 'durable', 'dlq').queue_url, this.durableDlq],
    ]);
    this.publisher = new OfflineTrialMessagePublisher(queues, this.messages);
    this.counters = new OfflineQueueCounterReader(queues);
    this.dlqReceiver = new OfflineDlqReceiver(queues, this.messages);
    this.warmup = new OfflineProviderWarmupInvoker(this.invoker);
    this.telemetry = new OfflineTelemetryProbe(this.execution.context.resource_prefix);
    this.executor = new TrialExecutor({
      store,
      queues: this.counters,
      dlq: this.dlqReceiver,
      durable: this.durable,
      telemetry: this.telemetry,
      publisher: this.publisher,
      warmup: this.warmup,
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
   * What admission, provisioning and readiness leave behind (design §10.2 P1-P3): the frozen core
   * files, the execution configuration item (A-09) and an enabled controller stream mapping.
   *
   * @example
   * const cloud = new OfflineCloud();
   * await cloud.startExecution();
   */
  async startExecution(options: { readonly withExecutionConfiguration?: boolean } = {}): Promise<void> {
    for (const [path, bytes] of this.execution.core_files) {
      const written = await this.storage.writeOnce(`${this.execution.package_directory}/${path}`, bytes);
      if (!written.ok) {
        throw new Error(`core file ${path} was not written (${written.error.code}); expected a fresh evidence root`);
      }
    }
    if (options.withExecutionConfiguration !== false) {
      const configured = await writeExecutionConfiguration(
        this.store,
        { execution: this.execution.identity, execution_manifest_sha256: this.execution.execution_manifest_sha256 },
        this.time,
      );
      if (!configured.ok) {
        throw new Error(`${configured.error.detail}; expected a fresh control table`);
      }
    }
    this.#feed.enable();
  }

  /** The plan of the declared trial at `sequence`. */
  plan(sequence: number): TrialPlan {
    return offlineTrialPlan(this.execution, sequence);
  }

  /** Starts the executor on a declared trial without driving time. */
  start(sequence: number): RunningTrial {
    return this.startPlan(this.plan(sequence));
  }

  /** Starts the executor on any plan, such as a declared one with a defect, without driving time. */
  startPlan(plan: TrialPlan): RunningTrial {
    const progress = { settled: false };
    const report = this.executor.execute(plan, this.gate).finally(() => {
      progress.settled = true;
    });
    report.catch(() => undefined);
    return { plan, report, isSettled: () => progress.settled };
  }

  /** Drives the cloud for `ms` of virtual time. */
  async advanceBy(ms: number): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += OFFLINE_STEP_MS) {
      await this.#step();
    }
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

  /** Drives until the trial's report settles; throws when it does not within OFFLINE_MAX_STEPS. */
  async finish(running: RunningTrial): Promise<TrialExecutionReport> {
    for (let step = 0; step < OFFLINE_MAX_STEPS && !running.isSettled(); step += 1) {
      await this.#step();
    }
    if (!running.isSettled()) {
      throw new Error(
        `trial ${running.plan.trial.trial_id} did not settle in ${String(OFFLINE_MAX_STEPS)} steps; expected a frozen or refused trial`,
      );
    }
    return running.report;
  }

  /** Runs one declared trial to its report. */
  runTrial(sequence: number): Promise<TrialExecutionReport> {
    return this.finish(this.start(sequence));
  }

  /** The evidence-root path of the runner journal. */
  runnerJournalPath(): string {
    return `${this.execution.package_directory}/${EXECUTION_PATHS.runnerJournal}`;
  }

  /** The execution package's files, keyed by package-relative path. */
  packageFiles(): ReadonlyMap<string, Uint8Array> {
    return this.storage.filesUnder(this.execution.package_directory);
  }

  /** Sends a message that is not the trial's onto the source queue (another group). */
  injectSourceMessage(body = '{"stray":true}'): string {
    const id = this.#queueIds.next();
    return this.messages.send(this.source, { body, message_group_id: `stray-${id}`, message_deduplication_id: id })
      .message_id;
  }

  /** Receives the source head now, as a consumer would, and leaves it in flight. */
  holdSourceMessage(): string {
    const received = this.source.receive();
    if (received === undefined) {
      throw new Error('the source queue has no visible message; expected one to hold in flight');
    }
    this.messages.noteReceived(received.message_id, this.time.now().getTime());
    return received.receipt_handle;
  }

  /** Deletes a held message by its receipt handle, as its consumer would on success. */
  releaseSourceMessage(receiptHandle: string): void {
    this.source.deleteMessage(receiptHandle);
  }

  /** Deletes every source message the event source mapping has not consumed (stray messages). */
  drainSource(): void {
    for (let received = this.source.receive(); received !== undefined; received = this.source.receive()) {
      this.source.deleteMessage(received.receipt_handle);
    }
  }

  /** Puts a message of `groupId` straight onto the DLQ, as a redrive of the trial message would. */
  injectDlqMessage(groupId: string, body: string): string {
    return this.messages.send(this.dlq, {
      body,
      message_group_id: groupId,
      message_deduplication_id: `dlq-${this.#queueIds.next()}`,
    }).message_id;
  }

  async #step(): Promise<void> {
    this.pump.tick();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await this.time.advanceBy(OFFLINE_STEP_MS);
  }
}
