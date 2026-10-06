// The safety supervisor's total-time verdict as cleanup reads it (BR-RUA-046, AC-RUA-049): a
// test sets whether the total target is exceeded.

import type { CleanupSafetyClock } from '../../../src/cleanup/cleanup-ports.ts';

/**
 * A total-time verdict a test sets.
 *
 * @example
 * const safety = new SettableCleanupSafetyClock();
 * safety.exceed();
 * safety.totalTargetExceeded(); // true
 */
export class SettableCleanupSafetyClock implements CleanupSafetyClock {
  #exceeded = false;

  exceed(): void {
    this.#exceeded = true;
  }

  totalTargetExceeded(): boolean {
    return this.#exceeded;
  }
}
