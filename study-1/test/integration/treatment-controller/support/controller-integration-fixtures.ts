// Composition helpers of the treatment-controller integration tests: the real controller over
// the InMemoryItemStore emulator, with its state port wrapped in ScriptedControllerStatePort and its
// journal opener exposed, so a test can script the signal transaction or hand over a stopped
// journal instance.

import { createDurableJournalPort } from '../../../../src/event-journal/durable-journal-port.ts';
import type { JournalScope } from '../../../../src/event-journal/journal-scope.ts';
import { JournalWriter } from '../../../../src/event-journal/journal-writer.ts';
import type { ExecutionIdentity } from '../../../../src/record-contract/primitives.ts';
import { CONTROLLER_JOURNAL_DEFINITIVE_RETRIES } from '../../../../src/treatment-controller/controller-composition.ts';
import { createControllerStatePort } from '../../../../src/treatment-controller/controller-state-port.ts';
import { TreatmentController } from '../../../../src/treatment-controller/treatment-controller.ts';
import { InMemoryItemStore } from '../../../support/durable-store/in-memory-item-store.ts';
import { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import { ScriptedControllerStatePort } from './scripted-controller-state-port.ts';

export interface ScriptedControllerHarness {
  readonly store: InMemoryItemStore;
  readonly log: RecordingMutationLog;
  readonly state: ScriptedControllerStatePort;
  readonly controller: TreatmentController;
}

/**
 * The real controller with a scripted signal moment. `openJournal` defaults to the production
 * writer (a new `treatment_controller` instance per record over the experiment journal).
 */
export function scriptedControllerHarness(
  deployment: ExecutionIdentity,
  openJournal?: (scope: JournalScope) => JournalWriter,
): ScriptedControllerHarness {
  const time = new VirtualTimeScheduler({ wallEpochMs: Date.UTC(2026, 9, 5, 12, 0, 3) });
  const log = new RecordingMutationLog();
  const store = new InMemoryItemStore({ clock: time, mutationLog: log });
  const ids = new SequentialUuidSource('cccccccc');
  const state = new ScriptedControllerStatePort(createControllerStatePort(store));
  const port = createDurableJournalPort(store, 'experiment_journal');
  const controller = new TreatmentController({
    deployment,
    state,
    ids,
    openJournal:
      openJournal ??
      ((scope): JournalWriter =>
        new JournalWriter({
          port,
          source: 'treatment_controller',
          instanceId: ids.next(),
          scope,
          clock: time,
          ids,
          maxDefinitiveRetries: CONTROLLER_JOURNAL_DEFINITIVE_RETRIES,
        })),
  });
  return { store, log, state, controller };
}
