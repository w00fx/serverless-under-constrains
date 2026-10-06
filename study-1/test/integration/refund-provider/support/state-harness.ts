// The provider's collaborators without the provider: the InMemoryItemStore emulator on virtual
// time, the real state port behind the scripted fake, and a real provider JournalWriter in the
// trial partition. The commit-execution and treatment-barrier suites drive these directly.

import { createDurableJournalPort } from '../../../../src/event-journal/durable-journal-port.ts';
import { JournalWriter } from '../../../../src/event-journal/journal-writer.ts';
import type { JournalEvent } from '../../../../src/event-journal/journal-event.ts';
import { PROVIDER_JOURNAL_DEFINITIVE_RETRIES } from '../../../../src/refund-provider/provider-composition.ts';
import { createProviderStatePort } from '../../../../src/refund-provider/provider-state-port.ts';
import { InMemoryItemStore } from '../../../support/durable-store/in-memory-item-store.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import {
  EPOCH_MS,
  MANIFEST_SHA,
  RUN,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_PK,
} from '../../../support/refund-provider/provider-fixtures.ts';
import { ProviderLogRecorder } from '../../../support/refund-provider/provider-log-recorder.ts';
import { ScriptedProviderStatePort } from './scripted-provider-state-port.ts';

export interface StateHarness {
  readonly store: InMemoryItemStore;
  readonly time: VirtualTimeScheduler;
  readonly ids: SequentialUuidSource;
  readonly state: ScriptedProviderStatePort;
  readonly journal: JournalWriter;
  readonly logs: ProviderLogRecorder;
}

/** A fresh emulator, scripted state port, trial-partition provider journal and log recorder. */
export function stateHarness(): StateHarness {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS, monotonicOriginNs: 7_000_000_000n });
  const store = new InMemoryItemStore({ clock: time });
  const ids = new SequentialUuidSource('88888888');
  const journal = new JournalWriter({
    port: createDurableJournalPort(store, 'experiment_journal'),
    source: 'refund_provider',
    instanceId: ids.next(),
    scope: {
      execution: RUN,
      execution_manifest_sha256: MANIFEST_SHA,
      partition: { kind: 'trial', trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
    },
    clock: time,
    ids,
    maxDefinitiveRetries: PROVIDER_JOURNAL_DEFINITIVE_RETRIES,
  });
  const state = new ScriptedProviderStatePort(createProviderStatePort(store));
  return { store, time, ids, state, journal, logs: new ProviderLogRecorder() };
}

/** The journal events of the trial partition, in journal order. */
export function journalEvents(harness: StateHarness): readonly JournalEvent[] {
  return harness.store
    .itemsIn('experiment_journal')
    .filter((item) => item.pk === TRIAL_PK)
    .map((item) => {
      const { pk: _pk, sk: _sk, ...event } = item;
      return event as unknown as JournalEvent;
    });
}

/** Stops the writer for good: its next append is ambiguous (BR-RUA-033 stop rule). */
export async function stopJournal(harness: StateHarness): Promise<void> {
  harness.store.scriptWriteFault({ kind: 'ambiguous', code: 'TimeoutError', applied: false }, { operation: 'write' });
  await harness.journal.append('provider_call_received', {
    provider_call_id: harness.ids.next(),
    raw_request_sha256: MANIFEST_SHA,
  });
  if (!harness.journal.isStopped()) {
    throw new Error('journal still writable after an ambiguous append; expected a stopped instance');
  }
}
