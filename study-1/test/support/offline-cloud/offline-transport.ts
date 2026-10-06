// The transport half of an offline cloud (design §12.3): the real refund provider behind the
// in-process Lambda Invoke of its published version, and the real treatment controller fed by the
// StreamFeed emulator of the caller-journal stream (with the controller mapping's filter), on the
// cloud's virtual clock and store. The trial cloud and the probe cloud both compose it, so the
// provider and controller a trial and the probe run against are wired one way.

import type { ExecutionIdentity } from '../../../src/record-contract/primitives.ts';
import { composeRefundProvider } from '../../../src/refund-provider/provider-composition.ts';
import { composeTreatmentController } from '../../../src/treatment-controller/controller-composition.ts';
import { consumeStreamEvent } from '../../../src/treatment-controller/stream-consumer.ts';
import { CONTROLLER_STREAM_FILTER } from '../../../src/treatment-controller/stream-record.ts';
import type { InMemoryItemStore } from '../durable-store/in-memory-item-store.ts';
import { StreamFeed } from '../durable-store/stream-feed.ts';
import { GOLDEN_PROVIDER_VERSION } from '../golden-builder/golden-values.ts';
import { SequentialUuidSource } from '../kernel/sequential-uuid-source.ts';
import type { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';
import { ProviderLogRecorder } from '../refund-provider/provider-log-recorder.ts';
import { ControllerLogRecorder } from '../transport-rehearsal/controller-log-recorder.ts';
import { InProcessProviderInvoker } from '../transport-rehearsal/in-process-provider-invoker.ts';

/** The provider's emulated Invoke and the controller's stream feed (enabled at readiness). */
export interface OfflineTransport {
  readonly invoker: InProcessProviderInvoker;
  readonly feed: StreamFeed;
}

/**
 * Composes the provider and the controller of `deployment` over the cloud's store and clock.
 *
 * @example
 * const { invoker, feed } = composeOfflineTransport(identity, store, time);
 * feed.enable(); // at readiness
 */
export function composeOfflineTransport(
  deployment: ExecutionIdentity,
  store: InMemoryItemStore,
  time: VirtualTimeScheduler,
): OfflineTransport {
  const provider = composeRefundProvider({
    deployment,
    store,
    ids: new SequentialUuidSource('99999999'),
    wall: time,
    monotonic: time,
    sleeper: time,
    log: new ProviderLogRecorder().sink,
  });
  const controller = composeTreatmentController({
    deployment,
    store,
    ids: new SequentialUuidSource('cccccccc'),
    wall: time,
  });
  const controllerLogs = new ControllerLogRecorder();
  const feed = new StreamFeed({
    source: store,
    table: 'caller_journal',
    scheduler: time,
    clock: time,
    consumer: (event): Promise<void> => consumeStreamEvent(event, controller, controllerLogs.sink),
    filters: [CONTROLLER_STREAM_FILTER],
  });
  return { invoker: new InProcessProviderInvoker(provider, GOLDEN_PROVIDER_VERSION), feed };
}
