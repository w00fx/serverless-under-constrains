// The offline transport rehearsal (design §12.3 "Transport rehearsal", WP-08, M0): the real
// provider, treatment controller and probe caller under one VirtualTimeScheduler, over the
// InMemoryItemStore emulator, the StreamFeed emulator of the caller-journal stream (with the
// controller mapping's filter) and the InProcessProviderInvoker. The harness plays the runner:
// it seeds the probe partition, writes the readiness canary (D-10), warms the provider once
// (addendum §2), then makes the single synchronous probe invocation (BR-RUA-027).

import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import { createDurableJournalPort } from '../../../src/event-journal/durable-journal-port.ts';
import type { JournalEvent } from '../../../src/event-journal/journal-event.ts';
import type { JournalScope } from '../../../src/event-journal/journal-scope.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import type { DecimalString } from '../../../src/record-contract/primitives.ts';
import { formatUtcMillis } from '../../../src/record-contract/timestamps.ts';
import { composeRefundProvider } from '../../../src/refund-provider/provider-composition.ts';
import type { ProviderInvocationResult, RefundProvider } from '../../../src/refund-provider/refund-provider.ts';
import { composeTreatmentController } from '../../../src/treatment-controller/controller-composition.ts';
import { consumeStreamEvent } from '../../../src/treatment-controller/stream-consumer.ts';
import { CONTROLLER_STREAM_FILTER } from '../../../src/treatment-controller/stream-record.ts';
import type { ProbeCaller, ProbeWorkloadReport } from '../../../src/transport-probe-caller/probe-caller.ts';
import { composeProbeCaller } from '../../../src/transport-probe-caller/probe-caller-composition.ts';
import { InMemoryItemStore } from '../durable-store/in-memory-item-store.ts';
import { StreamFeed } from '../durable-store/stream-feed.ts';
import { SequentialUuidSource } from '../kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';
import {
  armedTreatmentItem,
  EPOCH_MS,
  MANIFEST_SHA,
  PAYMENT_ID,
  paymentItem,
  PROBE,
  PROBE_ID,
  PROBE_PK,
  probeConfigItem,
  REFUND_REQUEST_ID,
} from '../../unit/refund-provider/support/provider-fixtures.ts';
import { ControllerLogRecorder } from './controller-log-recorder.ts';
import { InProcessProviderInvoker } from './in-process-provider-invoker.ts';

/** The provider version the rehearsal's callers target and the emulated Invoke reports. */
export const REHEARSAL_QUALIFIER = '3';
export const CANARY_PK = `${PROBE_ID}#canary`;
export const WARMUP_PK = `${PROBE_ID}#warmup`;
export const LAMBDA_REQUEST_ID = 'rehearsal-lambda-request-0001';
const MAX_DRIVE_ROUNDS = 1_000;

const CANARY_SCOPE: JournalScope = {
  execution: PROBE,
  execution_manifest_sha256: MANIFEST_SHA,
  partition: { kind: 'canary' },
};

export class TransportRehearsal {
  readonly time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS, monotonicOriginNs: 7_000_000_000n });
  readonly store = new InMemoryItemStore({ clock: this.time });
  readonly logs = new ControllerLogRecorder();
  readonly provider: RefundProvider;
  readonly invoker: InProcessProviderInvoker;
  readonly feed: StreamFeed;
  readonly #caller: ProbeCaller;
  readonly #runnerIds = new SequentialUuidSource('12121212');

  constructor() {
    const { time, store } = this;
    this.provider = composeRefundProvider({
      deployment: PROBE,
      store,
      ids: new SequentialUuidSource('99999999'),
      wall: time,
      monotonic: time,
      sleeper: time,
    });
    this.invoker = new InProcessProviderInvoker(this.provider, REHEARSAL_QUALIFIER);
    const controller = composeTreatmentController({
      deployment: PROBE,
      store,
      ids: new SequentialUuidSource('cccccccc'),
      wall: time,
    });
    this.feed = new StreamFeed({
      source: store,
      table: 'caller_journal',
      scheduler: time,
      clock: time,
      consumer: (event): Promise<void> => consumeStreamEvent(event, controller, this.logs.sink),
      filters: [CONTROLLER_STREAM_FILTER],
    });
    this.#caller = composeProbeCaller({
      deployment: PROBE,
      provider_qualifier: REHEARSAL_QUALIFIER,
      store,
      invoker: this.invoker,
      ids: new SequentialUuidSource('dddddddd'),
      wall: time,
      monotonic: time,
      scheduler: time,
    });
  }

  /** What the runner writes before the canary: configuration, payment and armed treatment. */
  seedProbePartition(): void {
    this.store.seed('control', probeConfigItem());
    this.store.seed('control', paymentItem(PROBE_PK));
    this.store.seed('control', armedTreatmentItem(PROBE_PK));
  }

  /**
   * Enables the stream mapping, writes the runner canary into `<probe>#canary` and drives time
   * until the controller acknowledged it. Throws when no acknowledgement exists (D-10 readiness).
   */
  async acknowledgeCanary(): Promise<JournalEvent> {
    this.feed.enable();
    const runner = new JournalWriter({
      port: createDurableJournalPort(this.store, 'caller_journal'),
      source: 'runner',
      instanceId: this.#runnerIds.next(),
      scope: CANARY_SCOPE,
      clock: this.time,
      ids: this.#runnerIds,
      maxDefinitiveRetries: 0,
    });
    const now = formatUtcMillis(this.time.now());
    const written = await runner.append(
      'caller_timeout_recorded',
      {
        attempt_id: this.#runnerIds.next(),
        provider_request_id: this.#runnerIds.next(),
        refund_request_id: 'readiness-canary',
        elapsed_ns: '0' as DecimalString,
        monotonic_origin_event_id: this.#runnerIds.next(),
        dispatch_at: now,
        deadline_at: now,
        timer_fired_at: now,
        abort_requested_at: now,
        recorded_at: now,
        arbiter_winner: 'TIMER',
        transport_settled_at_claim: false,
      },
      [this.#runnerIds.next()],
    );
    if (written.kind !== 'appended') {
      throw new Error(`canary append ${written.reason}; expected the runner canary to be written`);
    }
    await this.#drive(Promise.resolve());
    const ack = this.events('experiment_journal', CANARY_PK).find(
      (event) => event.record_type === 'controller_canary_acknowledged',
    );
    if (ack === undefined) {
      throw new Error(`no controller_canary_acknowledged in ${CANARY_PK}; expected the controller to be ready`);
    }
    return ack;
  }

  /** The runner's single provider warm-up before the probe invocation (addendum §2). */
  warmUpProvider(): Promise<ProviderInvocationResult> {
    return this.provider.handle({
      schema_version: 1,
      record_type: 'provider_warmup_request',
      transport_probe_id: PROBE_ID,
      execution_manifest_sha256: MANIFEST_SHA,
      warmup_id: this.#runnerIds.next(),
    });
  }

  /** The runner's single synchronous invocation of the probe caller, driven to quiescence. */
  async invokeProbe(): Promise<ProbeWorkloadReport> {
    const run = this.#caller.run({
      lambda_request_id: LAMBDA_REQUEST_ID,
      payload: {
        schema_version: 1,
        record_type: 'probe_workload_request',
        transport_probe_id: PROBE_ID,
        execution_manifest_sha256: MANIFEST_SHA,
        payment_id: PAYMENT_ID,
        refund_request_id: REFUND_REQUEST_ID,
        amount_minor: 10000,
        currency: 'BRL',
      },
    });
    await this.#drive(run);
    return run;
  }

  /** Canary, warm-up, probe invocation: the runner's probe sequence. */
  async runProbeSequence(): Promise<ProbeWorkloadReport> {
    this.seedProbePartition();
    await this.acknowledgeCanary();
    await this.warmUpProvider();
    return this.invokeProbe();
  }

  /** The journal events of one table partition, in sort-key order. */
  events(table: 'caller_journal' | 'experiment_journal', pk: string): readonly JournalEvent[] {
    return this.store
      .itemsIn(table)
      .filter((item) => item.pk === pk && !item.sk.startsWith('state#'))
      .map((item) => {
        const { pk: _pk, sk: _sk, ...event } = item;
        return event as unknown as JournalEvent;
      });
  }

  /** The probe partition's current treatment item. */
  treatment(): StoredItem | undefined {
    return this.store.peek('control', { pk: PROBE_PK, sk: 'treatment' });
  }

  // Runs timers and continuations until `work` settled, no provider execution is in flight and
  // no timer is pending. Time moves only here, so every interleaving is deterministic.
  async #drive(work: Promise<unknown>): Promise<void> {
    // A holder, not a local: the flag is set in a callback control-flow analysis cannot see.
    const progress = { settled: false };
    const markSettled = (): void => {
      progress.settled = true;
    };
    void work.then(markSettled, markSettled);
    for (let round = 0; round < MAX_DRIVE_ROUNDS; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.time.advanceUntilIdle();
      await this.invoker.whenIdle();
      if (progress.settled && this.time.pendingTimerCount() === 0 && this.feed.pendingCount() === 0) {
        return;
      }
    }
    throw new Error(`rehearsal did not quiesce within ${String(MAX_DRIVE_ROUNDS)} rounds; expected it to settle`);
  }
}
