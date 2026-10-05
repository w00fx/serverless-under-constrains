// A decorator of the real ControllerStatePort that scripts the signal transaction's moment:
// `beforeNextSignal(hook)` runs `hook` (for example another writer's conditional update on the
// same store) between the controller's reads and its signal transaction, which reproduces the
// race the §9.11 "re-read ALL_OLD and re-decide once" rule exists for; `answerNextSignal(outcome)`
// returns `outcome` instead of reaching the store, for outcomes the emulator cannot produce on
// demand; `failNextTreatmentRead(failure)` makes the next treatment read fail after the
// configuration read succeeded, which the emulator's per-table read faults cannot target.

import type { WriteOutcome } from '../../../../src/durable-store/item-store-port.ts';
import type {
  ControllerReadFailure,
  ControllerStatePort,
  SignalTransition,
} from '../../../../src/treatment-controller/controller-state-port.ts';

type SignalScript =
  | { readonly kind: 'before'; readonly hook: () => Promise<void> }
  | { readonly kind: 'answer'; readonly outcome: WriteOutcome };

export class ScriptedControllerStatePort implements ControllerStatePort {
  readonly #inner: ControllerStatePort;
  readonly #scripts: SignalScript[] = [];
  readonly #transitions: SignalTransition[] = [];
  #treatmentFailure: ControllerReadFailure | undefined;

  constructor(inner: ControllerStatePort) {
    this.#inner = inner;
  }

  readonly loadConfiguration: ControllerStatePort['loadConfiguration'] = (partition) =>
    this.#inner.loadConfiguration(partition);
  readonly loadTreatment: ControllerStatePort['loadTreatment'] = (partition) => {
    const failure = this.#treatmentFailure;
    this.#treatmentFailure = undefined;
    return failure === undefined
      ? this.#inner.loadTreatment(partition)
      : Promise.resolve({ ok: false, error: failure });
  };

  failNextTreatmentRead(failure: ControllerReadFailure): void {
    this.#treatmentFailure = failure;
  }

  beforeNextSignal(hook: () => Promise<void>): void {
    this.#scripts.push({ kind: 'before', hook });
  }

  answerNextSignal(outcome: WriteOutcome): void {
    this.#scripts.push({ kind: 'answer', outcome });
  }

  /** Every signal transition requested, in order. */
  transitions(): readonly SignalTransition[] {
    return [...this.#transitions];
  }

  async signal(transition: SignalTransition): Promise<WriteOutcome> {
    this.#transitions.push(transition);
    const script = this.#scripts.shift();
    if (script?.kind === 'answer') {
      return script.outcome;
    }
    await script?.hook();
    return this.#inner.signal(transition);
  }
}
