// Wires the probe caller from its runtime: the caller-journal writer (a new `probe_caller`
// source instance per invocation, BR-RUA-033), the durable attempt state, and the shared
// provider client with its deadline timer. The Lambda handler and the offline transport
// rehearsal both compose the caller through this function, so they run the same code.

import type { DurableItemStore } from '../durable-store/item-store-port.ts';
import { createDurableJournalPort } from '../event-journal/durable-journal-port.ts';
import { JournalWriter } from '../event-journal/journal-writer.ts';
import type {
  ExecutionIdentity,
  MonotonicClock,
  TimerScheduler,
  UuidSource,
  WallClock,
} from '../record-contract/primitives.ts';
import { DeadlineTimer } from '../provider-client/deadline-timer.ts';
import { createDurableAttemptStatePort } from '../provider-client/durable-attempt-state-port.ts';
import { ProviderClient } from '../provider-client/provider-client.ts';
import type { ProviderInvocationPort } from '../provider-client/provider-invocation-port.ts';
import { ProbeCaller } from './probe-caller.ts';

/** Identical retries of a definitively failed journal append (BR-RUA-033), beyond the first try. */
export const PROBE_CALLER_JOURNAL_DEFINITIVE_RETRIES = 2;

export interface ProbeCallerRuntime {
  readonly deployment: ExecutionIdentity;
  readonly provider_qualifier: string;
  readonly store: DurableItemStore;
  readonly invoker: ProviderInvocationPort;
  readonly ids: UuidSource;
  readonly wall: WallClock;
  readonly monotonic: MonotonicClock;
  readonly scheduler: TimerScheduler;
}

/**
 * Composes a probe caller over a durable store and a provider invocation port.
 *
 * @example
 * const caller = composeProbeCaller({ deployment, provider_qualifier: '3', store, invoker, ids, wall, monotonic, scheduler });
 * const report = await caller.run({ payload, lambda_request_id });
 */
export function composeProbeCaller(runtime: ProbeCallerRuntime): ProbeCaller {
  const port = createDurableJournalPort(runtime.store, 'caller_journal');
  const attempts = createDurableAttemptStatePort(runtime.store);
  return new ProbeCaller({
    deployment: runtime.deployment,
    provider_qualifier: runtime.provider_qualifier,
    openJournal: (scope) =>
      new JournalWriter({
        port,
        source: 'probe_caller',
        instanceId: runtime.ids.next(),
        scope,
        clock: runtime.wall,
        ids: runtime.ids,
        maxDefinitiveRetries: PROBE_CALLER_JOURNAL_DEFINITIVE_RETRIES,
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
      }),
  });
}
