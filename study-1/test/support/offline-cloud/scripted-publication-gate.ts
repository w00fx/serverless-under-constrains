// A named fake of the execution's publication gate (design §5.3 `PublicationGate`, §10.2 T5): open
// until a test closes it or interrupts the execution, as the lease, the safety limits and SIGINT
// do in the execution runner.

import type { PublicationGate, TrialInterruption } from '../../../src/trial-execution/trial-execution-ports.ts';

export class ScriptedPublicationGate implements PublicationGate {
  #publicationAllowed = true;
  #mayStartTrial = true;
  #interruption: TrialInterruption | undefined;

  publicationAllowed(): boolean {
    return this.#publicationAllowed;
  }

  mayStartTrial(): boolean {
    return this.#mayStartTrial;
  }

  interruption(): TrialInterruption | undefined {
    return this.#interruption;
  }

  /** The lease is uncertain: publication is not allowed (design §10.3). */
  withholdPublication(): void {
    this.#publicationAllowed = false;
  }

  /** The safety limits leave no room for another trial. */
  refuseTrials(): void {
    this.#mayStartTrial = false;
  }

  /** An interruption source fired; it stays set. */
  interrupt(interruption: TrialInterruption): void {
    this.#interruption = interruption;
  }
}
