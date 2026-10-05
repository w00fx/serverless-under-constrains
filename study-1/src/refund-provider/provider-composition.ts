// Wires the provider from its runtime: the durable store binds the state port and the
// experiment-journal writer, which gets a new source instance per invocation (BR-RUA-033, design
// §5.3 "new source instance per invocation"). The Lambda handler and the offline transport
// rehearsal (WP-08 `InProcessProviderInvoker`) both compose the provider through this function,
// so they run the same code.

import type { DurableItemStore } from '../durable-store/item-store-port.ts';
import { createDurableJournalPort } from '../event-journal/durable-journal-port.ts';
import { JournalWriter } from '../event-journal/journal-writer.ts';
import type {
  ExecutionIdentity,
  MonotonicClock,
  Sleeper,
  UuidSource,
  WallClock,
} from '../record-contract/primitives.ts';
import { createProviderStatePort } from './provider-state-port.ts';
import { RefundProvider } from './refund-provider.ts';

/** Identical retries of a definitively failed journal append (BR-RUA-033), beyond the first try. */
export const PROVIDER_JOURNAL_DEFINITIVE_RETRIES = 2;

export interface ProviderRuntime {
  readonly deployment: ExecutionIdentity;
  readonly store: DurableItemStore;
  readonly ids: UuidSource;
  readonly wall: WallClock;
  readonly monotonic: MonotonicClock;
  readonly sleeper: Sleeper;
}

/**
 * Composes a provider over a durable store.
 *
 * @example
 * const provider = composeRefundProvider({ deployment, store, ids, wall, monotonic, sleeper });
 * const response = await provider.handle(event);
 */
export function composeRefundProvider(runtime: ProviderRuntime): RefundProvider {
  const port = createDurableJournalPort(runtime.store, 'experiment_journal');
  return new RefundProvider({
    deployment: runtime.deployment,
    state: createProviderStatePort(runtime.store),
    openJournal: (scope) =>
      new JournalWriter({
        port,
        source: 'refund_provider',
        instanceId: runtime.ids.next(),
        scope,
        clock: runtime.wall,
        ids: runtime.ids,
        maxDefinitiveRetries: PROVIDER_JOURNAL_DEFINITIVE_RETRIES,
      }),
    ids: runtime.ids,
    wall: runtime.wall,
    monotonic: runtime.monotonic,
    sleeper: runtime.sleeper,
  });
}
