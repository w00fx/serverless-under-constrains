// Wires the Durable refund caller from its runtime: the trial registry over the store, a new
// `durable_caller` journal writer per step attempt (BR-RUA-033), the durable attempt state, the
// shared provider client with its deadline timer, and the request-state recorder over the same
// writer. The Lambda handler and the offline tests compose the caller through this function, so
// they run the same code.

import type { DurableItemStore } from '../durable-store/item-store-port.ts';
import { createDurableJournalPort } from '../event-journal/durable-journal-port.ts';
import { JournalWriter } from '../event-journal/journal-writer.ts';
import { DeadlineTimer } from '../provider-client/deadline-timer.ts';
import { createDurableAttemptStatePort } from '../provider-client/durable-attempt-state-port.ts';
import { ProviderClient } from '../provider-client/provider-client.ts';
import type { ProviderInvocationPort } from '../provider-client/provider-invocation-port.ts';
import type { MonotonicClock, TimerScheduler, UuidSource, WallClock } from '../record-contract/primitives.ts';
import { OR_RUA_001_REFUND } from '../trial-message/approved-refund.ts';
import { createStoreTrialRegistry } from '../trial-message/trial-registry.ts';
import { RequestStateRecorder } from '../conventional-variant/request-state/request-state-recorder.ts';
import type { DurableDeployment } from './durable-environment.ts';
import { DurableRefundCaller } from './durable-refund-caller.ts';

/** Identical retries of a definitively failed journal write (BR-RUA-033), beyond the first try. */
export const DURABLE_JOURNAL_DEFINITIVE_RETRIES = 2;

export interface DurableRuntime {
  readonly deployment: DurableDeployment;
  readonly provider_qualifier: string;
  /** Holds the caller journal and the trial registry. */
  readonly store: DurableItemStore;
  readonly invoker: ProviderInvocationPort;
  readonly ids: UuidSource;
  readonly wall: WallClock;
  readonly monotonic: MonotonicClock;
  readonly scheduler: TimerScheduler;
}

/**
 * Composes the Durable refund caller over a durable store and a provider invocation port.
 *
 * @example
 * const caller = composeDurableCaller({ deployment, provider_qualifier: '3', store, invoker, ids, wall, monotonic, scheduler });
 * const result = await caller.runStepAttempt(delivery, invocation);
 */
export function composeDurableCaller(runtime: DurableRuntime): DurableRefundCaller {
  const port = createDurableJournalPort(runtime.store, 'caller_journal');
  const attempts = createDurableAttemptStatePort(runtime.store);
  return new DurableRefundCaller({
    deployment: runtime.deployment,
    provider_qualifier: runtime.provider_qualifier,
    refund: OR_RUA_001_REFUND,
    registry: createStoreTrialRegistry(runtime.store),
    openJournal: (scope) =>
      new JournalWriter({
        port,
        source: 'durable_caller',
        instanceId: runtime.ids.next(),
        scope,
        clock: runtime.wall,
        ids: runtime.ids,
        maxDefinitiveRetries: DURABLE_JOURNAL_DEFINITIVE_RETRIES,
      }),
    openClient: (journal, scope) =>
      new ProviderClient({
        invoker: runtime.invoker,
        attempts,
        journal,
        scope,
        monotonic: runtime.monotonic,
        wall: runtime.wall,
        timer: new DeadlineTimer({ monotonic: runtime.monotonic, scheduler: runtime.scheduler }),
        ids: runtime.ids,
        maxDefinitiveRetries: DURABLE_JOURNAL_DEFINITIVE_RETRIES,
      }),
    openRecorder: (journal, scope) =>
      new RequestStateRecorder({
        store: runtime.store,
        journal,
        scope,
        maxDefinitiveRetries: DURABLE_JOURNAL_DEFINITIVE_RETRIES,
      }),
  });
}
