// The in-process arbiter of BR-RUA-023: "One in-process arbiter permits only the timer or
// transport settlement to win." JavaScript runs one callback at a time, so the first claim is
// decided before any other claimant can run, and it stays decided forever.

import type { ArbiterWinner } from '../record-contract/records/group-b/vocabulary.ts';

/**
 * Decides, once, whether the deadline timer or the transport settlement won an attempt.
 *
 * @example
 * const arbiter = new SettlementArbiter();
 * arbiter.claim('TRANSPORT'); // true
 * arbiter.claim('TIMER'); // false: the transport already won
 * arbiter.winner(); // 'TRANSPORT'
 */
export class SettlementArbiter {
  #winner: ArbiterWinner | undefined;

  /** Claims the win for `claimant`; true only for the first claim ever made. */
  claim(claimant: ArbiterWinner): boolean {
    if (this.#winner !== undefined) {
      return false;
    }
    this.#winner = claimant;
    return true;
  }

  /** The claimant that won, or undefined while nobody has claimed. */
  winner(): ArbiterWinner | undefined {
    return this.#winner;
  }
}
