// Named fake of the operator's interrupts (design §11; production: `ProcessInterruptSignals`, the
// process's SIGINT): a test fires an interrupt by hand, and the fake reports how many listeners are
// still subscribed, so a test proves the command unsubscribed when the execution ended. Its
// conformance test (`process-interrupts.integration.test.ts`) holds the production source to the
// same subscribe / unsubscribe answers over a real SIGINT listener.

import type { InterruptSource } from '../../../../src/operator-cli/execute-commands.ts';

export class ManualInterruptSource implements InterruptSource {
  readonly #listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Delivers one interrupt to every subscribed listener. */
  fire(): void {
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  /** How many listeners are subscribed. */
  listening(): number {
    return this.#listeners.size;
  }
}
