// The execution's publication gate (design §5.3 `PublicationGate`, §10.2 T5 and interruption;
// BR-RUA-045, BR-RUA-046; AC-RUA-033, AC-RUA-049). Three sources interrupt an execution: SIGINT
// (`OPERATOR_ABORT`), lease loss (`LEASE_LOST`) and the active-time deadline (`SAFETY_DEADLINE`).
// The first one latches and stays: after it no trial starts, nothing is published, the active trial
// freezes indeterminate and emergency cleanup follows. The deadline needs no timer: every question
// the gate answers re-reads the supervisor's monotonic clock, so the trial observer, which asks
// after each sleep, sees the deadline at its next poll, and the runner sees it before the next
// trial. A later SIGINT is reported and never abandons cleanup (design §11).

import type { TrialInterruption, PublicationGate } from '../trial-execution/trial-execution-ports.ts';
import type { ExecutionSafety } from './execution-ports.ts';

/** What the gate reads of the lease. */
export interface GateLeaseView {
  publicationAllowed(): boolean;
}

/** The answer to an operator abort: the first one interrupts, later ones only report. */
export type AbortAnswer = 'interrupting' | 'already_interrupted';

/**
 * The publication gate of one execution.
 *
 * @example
 * const gate = new ExecutionGate(lease);
 * gate.arm(supervisor); // once the lease is held and the deadline clock has started
 * if (gate.mayStartTrial()) await executor.execute(plan, gate);
 */
export class ExecutionGate implements PublicationGate {
  readonly #lease: GateLeaseView;
  #safety: ExecutionSafety | undefined;
  #interruption: TrialInterruption | undefined;

  constructor(lease: GateLeaseView) {
    this.#lease = lease;
  }

  /** Starts deadline supervision; until then no trial may start. */
  arm(safety: ExecutionSafety): void {
    this.#safety = safety;
  }

  /**
   * Latches `interruption` unless one is already set; true when this call latched it.
   *
   * @example
   * gate.interrupt({ cause: 'LEASE_LOST', detail: 'ownership mismatch' }); // true
   */
  interrupt(interruption: TrialInterruption): boolean {
    if (this.interruption() !== undefined) {
      return false;
    }
    this.#interruption = interruption;
    return true;
  }

  /**
   * SIGINT: the first one interrupts with `OPERATOR_ABORT`; any later one, or one after another
   * interruption, is only reported.
   *
   * @example
   * gate.abort('SIGINT'); // 'interrupting'
   * gate.abort('SIGINT'); // 'already_interrupted'
   */
  abort(detail: string): AbortAnswer {
    return this.interrupt({ cause: 'OPERATOR_ABORT', detail }) ? 'interrupting' : 'already_interrupted';
  }

  /** The latched interruption; the active-time deadline latches itself the first time it is seen. */
  interruption(): TrialInterruption | undefined {
    if (this.#interruption === undefined && this.#safety?.activeDeadlineReached() === true) {
      this.#interruption = {
        cause: 'SAFETY_DEADLINE',
        detail: 'the active-time deadline was reached (BR-RUA-046)',
      };
    }
    return this.#interruption;
  }

  /** The latched interruption, without consulting the deadline (for reporting after P6). */
  latched(): TrialInterruption | undefined {
    return this.#interruption;
  }

  /** True while the gate is armed, nothing interrupted the execution and the limits leave room. */
  mayStartTrial(): boolean {
    return this.interruption() === undefined && this.#safety?.mayStartTrial() === true;
  }

  /** True while the lease is confirmed and nothing interrupted the execution (design §10.3). */
  publicationAllowed(): boolean {
    return this.interruption() === undefined && this.#lease.publicationAllowed();
  }
}
