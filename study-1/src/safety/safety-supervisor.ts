// Real-time safety supervision of one execution (BR-RUA-046, AC-RUA-049; design §5.3, §8.17).
// Elapsed time is measured on the injected monotonic clock from the execution's start reading,
// so wall-clock steps never move a deadline (RF V3/V4). At the active-time deadline no new
// trial starts; past the total target the execution has a duration breach, but cleanup goes on.
// The supervisor decides nothing about cleanup itself: it answers the runner's questions and
// reports the two duration checks.

import type { MonotonicClock, WallClock } from '../record-contract/primitives.ts';
import type { SafetyCheck } from '../record-contract/records/group-c/safety_assessment.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { SafetyLimits } from './safety-limits.ts';

const NS_PER_MS = 1_000_000n;

export interface SafetySupervisorDeps {
  readonly monotonic: MonotonicClock;
  readonly wall: WallClock;
  readonly limits: SafetyLimits;
  /** The monotonic reading taken when the execution's first mutation started. */
  readonly startedNs: bigint;
}

/**
 * Watches the active-time deadline and the total target of one execution.
 *
 * @example
 * const supervisor = new SafetySupervisor({ monotonic, wall, limits: RUN_SAFETY, startedNs: monotonic.nowNs() });
 * if (supervisor.mayStartTrial()) startNextTrial();
 */
export class SafetySupervisor {
  readonly #deps: SafetySupervisorDeps;
  #activeEndedMs: bigint | undefined;

  constructor(deps: SafetySupervisorDeps) {
    this.#deps = deps;
  }

  /**
   * True while the active-time deadline has not been reached and active work has not ended.
   *
   * @example
   * supervisor.mayStartTrial(); // false once 4,500 s have elapsed in a run
   */
  mayStartTrial(): boolean {
    return this.#activeEndedMs === undefined && !this.activeDeadlineReached();
  }

  /**
   * True once the elapsed time reaches the active-time maximum (the deadline itself counts).
   *
   * @example
   * supervisor.activeDeadlineReached(); // true at exactly 600,000 ms into a probe
   */
  activeDeadlineReached(): boolean {
    return this.#elapsedMs() >= BigInt(this.#deps.limits.active_ms);
  }

  /**
   * True once the elapsed time exceeds the total target: a duration breach, never a reason to
   * abandon cleanup (BR-RUA-046).
   *
   * @example
   * supervisor.totalTargetExceeded(); // true at 5,400,001 ms into a run
   */
  totalTargetExceeded(): boolean {
    return this.#elapsedMs() > BigInt(this.#deps.limits.total_ms);
  }

  /**
   * Freezes the active duration when active work ends (normally or by interruption); later
   * calls keep the first reading.
   *
   * @example
   * supervisor.markActiveEnded(); // the ACTIVE_TIME check now reports this duration
   */
  markActiveEnded(): void {
    this.#activeEndedMs ??= this.#elapsedMs();
  }

  /**
   * The ACTIVE_TIME and TOTAL_TIME checks at this instant. The active duration is the frozen one
   * once active work ended, else the elapsed time so far; a duration above its maximum is
   * `breached`. Durations are whole milliseconds, rounded down.
   *
   * @example
   * supervisor.checks()[0]; // { boundary: 'ACTIVE_TIME', declared_limit: '4500000 ms', observed: '12000 ms', result: 'within_limits', ... }
   */
  checks(): readonly [SafetyCheck, SafetyCheck] {
    const elapsed = this.#elapsedMs();
    const checkedAt = formatUtcMillis(this.#deps.wall.now());
    const active = this.#activeEndedMs ?? elapsed;
    return [
      durationCheck('ACTIVE_TIME', this.#deps.limits.active_ms, active, checkedAt),
      durationCheck('TOTAL_TIME', this.#deps.limits.total_ms, elapsed, checkedAt),
    ];
  }

  #elapsedMs(): bigint {
    const elapsedNs = this.#deps.monotonic.nowNs() - this.#deps.startedNs;
    return elapsedNs < 0n ? 0n : elapsedNs / NS_PER_MS;
  }
}

function durationCheck(
  boundary: 'ACTIVE_TIME' | 'TOTAL_TIME',
  limitMs: number,
  observedMs: bigint,
  checkedAt: SafetyCheck['checked_at'],
): SafetyCheck {
  return {
    boundary,
    declared_limit: `${String(limitMs)} ms`,
    observed: `${observedMs.toString()} ms`,
    result: observedMs > BigInt(limitMs) ? 'breached' : 'within_limits',
    evidence_refs: [],
    checked_at: checkedAt,
  };
}
