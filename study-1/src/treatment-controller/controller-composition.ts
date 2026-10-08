// Wires the controller from its runtime: the durable store binds the state port and the
// experiment-journal writer, which gets a new `treatment_controller` source instance per handled
// record (BR-RUA-033). The Lambda handler and the offline transport rehearsal both compose the
// controller through this function, so they run the same code.

import type { DurableItemStore } from '../durable-store/item-store-port.ts';
import { createDurableJournalPort } from '../event-journal/durable-journal-port.ts';
import { JournalWriter } from '../event-journal/journal-writer.ts';
import type { ExecutionIdentity, UuidSource, WallClock } from '../record-contract/primitives.ts';
import { createControllerStatePort } from './controller-state-port.ts';
import { TreatmentController } from './treatment-controller.ts';

/** Identical retries of a definitively failed journal append (BR-RUA-033), beyond the first try. */
export const CONTROLLER_JOURNAL_DEFINITIVE_RETRIES = 2;

export interface ControllerRuntime {
  readonly deployment: ExecutionIdentity;
  readonly store: DurableItemStore;
  readonly ids: UuidSource;
  readonly wall: WallClock;
}

/**
 * Composes a controller over a durable store.
 *
 * @example
 * const controller = composeTreatmentController({ deployment, store, ids, wall });
 * await consumeStreamEvent(event, controller, log);
 */
export function composeTreatmentController(runtime: ControllerRuntime): TreatmentController {
  const port = createDurableJournalPort(runtime.store, 'experiment_journal');
  return new TreatmentController({
    deployment: runtime.deployment,
    state: createControllerStatePort(runtime.store),
    openJournal: (scope) =>
      new JournalWriter({
        port,
        source: 'treatment_controller',
        instanceId: runtime.ids.next(),
        scope,
        clock: runtime.wall,
        ids: runtime.ids,
        maxDefinitiveRetries: CONTROLLER_JOURNAL_DEFINITIVE_RETRIES,
      }),
    ids: runtime.ids,
  });
}
