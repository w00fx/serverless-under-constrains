// The operator's interrupts as the execute commands receive them (design §11): every SIGINT the
// process gets. Installing a listener replaces Node's default SIGINT exit, so the execution runner,
// not the signal, decides when the process ends: the first SIGINT interrupts the execution and
// cleanup still runs to its end.

import process from 'node:process';

import type { InterruptSource } from '../execute-commands.ts';

/**
 * The process's SIGINT.
 *
 * @example
 * const unsubscribe = new ProcessInterruptSignals().subscribe(() => runner.abort('SIGINT'));
 */
export class ProcessInterruptSignals implements InterruptSource {
  subscribe(listener: () => void): () => void {
    process.on('SIGINT', listener);
    return (): void => {
      process.off('SIGINT', listener);
    };
  }
}
