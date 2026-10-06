// The live settlement observer (design §5.3 `SettlementObserver`, §8.12, §10.2 T7 and T9; BR-RUA-032,
// D-32). It samples a published trial, or the invoked transport probe, through the unit's round
// reader every poll interval on the grid `published_at + k × 30 s`
// until the stabilization window is complete, the observation deadline passes, or the execution
// is interrupted. The window is complete when the §8.12 evaluator would establish settlement if
// the next recheck saw exactly the last sample again, so the observer and the oracle's G6 judge
// with the same function and never disagree on when a window ends.
//
// After the runner has collected the evidence (T8), `recheckBeforeFreeze` takes the D-32
// pre-freeze sample. A quiet recheck establishes settlement and the collected buffer is frozen; any
// activity restarts the window with PRE_FREEZE_ACTIVITY and the runner observes again, until the
// deadline. The evaluator ignores every sample after the deadline, so a recheck that comes too late
// leaves settlement not established, and the trial still freezes (D-29). `settle` runs that whole
// T7-T9 loop with the unit's collection, so the trial and the probe executors share it.

import type { Sleeper, UtcMillis, WallClock } from '../record-contract/primitives.ts';
import { evaluateSettlement } from '../settlement/evaluate-settlement.ts';
import type { SettlementAssessment, SettlementPolicy, SettlementSample } from '../settlement/settlement-policy.ts';
import type { SettlementReading, SettlementRoundReader } from './settlement-reading.ts';
import type { TrialInterruption } from './trial-execution-ports.ts';

/** What one observation reads, from when, under which policy, and what was observed before. */
export interface ObservationPlan {
  /** One round of the unit's settlement reads. */
  readonly read: SettlementRoundReader;
  readonly published_at: UtcMillis;
  readonly policy: SettlementPolicy;
  /** Every round of the unit so far, in order; empty for the first observation. */
  readonly prior: readonly SettlementReading[];
  /** The execution's interruption, read before every poll (design §10.2). */
  readonly interruption: () => TrialInterruption | undefined;
}

/** Why an observation stopped. */
export type ObservationStop = 'window_complete' | 'deadline' | 'interrupted';

/** An observation: every round so far, the evaluator's judgement of them and why it stopped. */
export interface Observation {
  readonly stop: ObservationStop;
  readonly rounds: readonly SettlementReading[];
  readonly assessment: SettlementAssessment;
  /** The interruption that stopped it, when `stop` is `interrupted`. */
  readonly interruption?: TrialInterruption;
}

/** The pre-freeze recheck: settlement established, or activity that sends the runner back to T7. */
export interface SettlementRecheck {
  readonly kind: 'established' | 'activity';
  readonly rounds: readonly SettlementReading[];
  readonly assessment: SettlementAssessment;
}

/**
 * A unit's settled (or unsettled) capture, ready to freeze: its collection, every round, the
 * judgement and, when the execution was interrupted before a quiet recheck, the interruption.
 */
export interface SettledCapture<C> {
  readonly collection: C;
  readonly rounds: readonly SettlementReading[];
  readonly assessment: SettlementAssessment;
  readonly interruption?: TrialInterruption;
}

export interface SettlementObserverDeps {
  readonly clock: WallClock;
  readonly sleeper: Sleeper;
}

/**
 * The samples of some rounds, in order.
 *
 * @example
 * samplesOf(observation.rounds).length; // observation.rounds.length
 */
export function samplesOf(rounds: readonly SettlementReading[]): readonly SettlementSample[] {
  return rounds.map((round) => round.sample);
}

/**
 * Whether the stabilization window of these samples is complete: a quiet recheck that repeats the
 * last sample would establish settlement.
 *
 * @example
 * windowComplete(samples, TRIAL_SETTLEMENT_POLICY, publishedAt); // true after 120 s of quiet samples
 */
export function windowComplete(
  samples: readonly SettlementSample[],
  policy: SettlementPolicy,
  publishedAt: UtcMillis,
): boolean {
  const last = samples.at(-1);
  if (last === undefined) {
    return false;
  }
  const repeated: SettlementSample = { ...last, phase: 'pre_freeze_recheck' };
  return evaluateSettlement([...samples, repeated], policy, publishedAt).status === 'established';
}

/**
 * The next poll instant on the grid `published_at + k × poll_interval_ms` (k ≥ 1) strictly after
 * `nowMs`.
 *
 * @example
 * nextPollMs(Date.parse(publishedAt), Date.parse(publishedAt) + 31_000, TRIAL_SETTLEMENT_POLICY); // published + 60 s
 */
export function nextPollMs(publishedMs: number, nowMs: number, policy: SettlementPolicy): number {
  const elapsedPolls = Math.floor((nowMs - publishedMs) / policy.poll_interval_ms);
  return publishedMs + Math.max(1, elapsedPolls + 1) * policy.poll_interval_ms;
}

export class SettlementObserver {
  readonly #deps: SettlementObserverDeps;

  constructor(deps: SettlementObserverDeps) {
    this.#deps = deps;
  }

  /**
   * Samples until the window is complete, the deadline passes or the execution is interrupted.
   *
   * @example
   * const observation = await observer.observe({ target, published_at, policy, prior: [], interruption });
   * if (observation.stop === 'window_complete') collect();
   */
  async observe(plan: ObservationPlan): Promise<Observation> {
    const publishedMs = Date.parse(plan.published_at);
    const deadlineMs = publishedMs + plan.policy.observation_deadline_ms;
    const rounds = [...plan.prior];
    for (;;) {
      const pollMs = nextPollMs(publishedMs, this.#deps.clock.now().getTime(), plan.policy);
      const before = this.#interrupted(rounds, plan);
      if (before !== undefined) {
        return before;
      }
      if (pollMs > deadlineMs) {
        return this.#stopped('deadline', rounds, plan);
      }
      await this.#deps.sleeper.sleep(pollMs - this.#deps.clock.now().getTime());
      const after = this.#interrupted(rounds, plan);
      if (after !== undefined) {
        return after;
      }
      rounds.push(await plan.read('observation', rounds.at(-1)?.sample));
      if (windowComplete(samplesOf(rounds), plan.policy, plan.published_at)) {
        return this.#stopped('window_complete', rounds, plan);
      }
    }
  }

  /**
   * The D-32 pre-freeze recheck after collection.
   *
   * @example
   * const recheck = await observer.recheckBeforeFreeze(plan, observation.rounds);
   * if (recheck.kind === 'established') freeze(buffer);
   */
  async recheckBeforeFreeze(plan: ObservationPlan, prior: readonly SettlementReading[]): Promise<SettlementRecheck> {
    const round = await plan.read('pre_freeze_recheck', prior.at(-1)?.sample);
    const rounds = [...prior, round];
    const assessment = evaluateSettlement(samplesOf(rounds), plan.policy, plan.published_at);
    return { kind: assessment.status === 'established' ? 'established' : 'activity', rounds, assessment };
  }

  /**
   * T7-T9 for one unit: observe until the window completes, collect, recheck; activity before the
   * deadline sends it back to T7. An observation that ends at the deadline or on an interruption,
   * or an interruption seen while collecting, ends with the collection and no recheck: a unit
   * collecting its evidence is still active, so it freezes unsettled (design §10.2,
   * evidence/WP-26/decisions.md).
   *
   * @example
   * const settled = await observer.settle({ read, published_at, policy, interruption }, collect);
   * if (settled.interruption !== undefined) journal.record('trial_interrupted', settled.interruption);
   */
  async settle<C>(plan: Omit<ObservationPlan, 'prior'>, collect: () => Promise<C>): Promise<SettledCapture<C>> {
    let rounds: readonly SettlementReading[] = [];
    for (;;) {
      const observed = await this.observe({ ...plan, prior: rounds });
      if (observed.stop !== 'window_complete') {
        return { ...capturedObservation(observed), collection: await collect() };
      }
      const collection = await collect();
      const interruption = plan.interruption();
      if (interruption !== undefined) {
        return { ...capturedObservation({ ...observed, interruption }), collection };
      }
      const recheck = await this.recheckBeforeFreeze({ ...plan, prior: observed.rounds }, observed.rounds);
      rounds = recheck.rounds;
      if (recheck.kind === 'established') {
        return { collection, rounds, assessment: recheck.assessment };
      }
    }
  }

  #interrupted(rounds: readonly SettlementReading[], plan: ObservationPlan): Observation | undefined {
    const interruption = plan.interruption();
    return interruption === undefined ? undefined : { ...this.#stopped('interrupted', rounds, plan), interruption };
  }

  #stopped(stop: ObservationStop, rounds: readonly SettlementReading[], plan: ObservationPlan): Observation {
    return { stop, rounds, assessment: evaluateSettlement(samplesOf(rounds), plan.policy, plan.published_at) };
  }
}

function capturedObservation(observed: Observation): Omit<SettledCapture<never>, 'collection'> {
  const { rounds, assessment, interruption } = observed;
  return interruption === undefined ? { rounds, assessment } : { rounds, assessment, interruption };
}
