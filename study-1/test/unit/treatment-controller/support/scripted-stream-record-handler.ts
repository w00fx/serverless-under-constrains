// Scripted stand-in for the TreatmentController at the consumer boundary (`StreamRecordHandler`).
// Each `handle` consumes the next script: return an outcome, or throw an error (a ControllerFault
// or any other error). It records every record it was given, in order.

import type { StreamRecordHandler } from '../../../../src/treatment-controller/stream-consumer.ts';
import type { StreamInsertRecord } from '../../../../src/treatment-controller/stream-record.ts';
import type { ControllerOutcome } from '../../../../src/treatment-controller/treatment-controller.ts';

type HandlerScript =
  { readonly kind: 'return'; readonly outcome: ControllerOutcome } | { readonly kind: 'throw'; readonly error: Error };

export class ScriptedStreamRecordHandler implements StreamRecordHandler {
  readonly #scripts: HandlerScript[] = [];
  readonly #handled: StreamInsertRecord[] = [];

  returnNext(outcome: ControllerOutcome): void {
    this.#scripts.push({ kind: 'return', outcome });
  }

  throwNext(error: Error): void {
    this.#scripts.push({ kind: 'throw', error });
  }

  handled(): readonly StreamInsertRecord[] {
    return [...this.#handled];
  }

  handle(record: StreamInsertRecord): Promise<ControllerOutcome> {
    this.#handled.push(record);
    const script = this.#scripts.shift();
    if (script === undefined) {
      return Promise.reject(
        new Error(`unscripted handle of ${record.sequence_number}; expected a script queued first`),
      );
    }
    return script.kind === 'return' ? Promise.resolve(script.outcome) : Promise.reject(script.error);
  }
}
