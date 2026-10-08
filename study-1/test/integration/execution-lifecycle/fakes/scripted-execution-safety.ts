// The supervisor's view the runner reads, scripted: a test reaches the active-time deadline or
// exceeds the total target by a call instead of by elapsed time, and reads how often the runner
// asked. The real `SafetySupervisor` measures monotonic time; the AC-RUA-049 tests use it.

import type { SafetyCheck } from '../../../../src/record-contract/records/group-c/safety_assessment.ts';
import type { UtcMillis } from '../../../../src/record-contract/primitives.ts';
import type { ExecutionSafety } from '../../../../src/execution-lifecycle/execution-ports.ts';

const CHECKED_AT = '2026-10-05T12:00:00.000Z' as UtcMillis;

/**
 * An execution safety whose deadline and target are switched by the test.
 *
 * @example
 * const safety = new ScriptedExecutionSafety();
 * safety.reachDeadline();
 * safety.mayStartTrial(); // false
 */
export class ScriptedExecutionSafety implements ExecutionSafety {
  #deadline = false;
  #exceeded = false;
  #activeEnded = 0;

  /** The active-time deadline is reached from now on. */
  reachDeadline(): void {
    this.#deadline = true;
  }

  /** The total target is exceeded from now on. */
  exceedTotal(): void {
    this.#exceeded = true;
  }

  /** How many times active work was marked ended. */
  activeEndedCalls(): number {
    return this.#activeEnded;
  }

  mayStartTrial(): boolean {
    return !this.#deadline && this.#activeEnded === 0;
  }

  activeDeadlineReached(): boolean {
    return this.#deadline;
  }

  totalTargetExceeded(): boolean {
    return this.#exceeded;
  }

  markActiveEnded(): void {
    this.#activeEnded += 1;
  }

  checks(): readonly SafetyCheck[] {
    return [
      {
        boundary: 'ACTIVE_TIME',
        declared_limit: '4500000 ms',
        observed: '1000 ms',
        result: this.#deadline ? 'breached' : 'within_limits',
        evidence_refs: [],
        checked_at: CHECKED_AT,
      },
      {
        boundary: 'TOTAL_TIME',
        declared_limit: '5400000 ms',
        observed: '1000 ms',
        result: this.#exceeded ? 'breached' : 'within_limits',
        evidence_refs: [],
        checked_at: CHECKED_AT,
      },
    ];
  }
}
