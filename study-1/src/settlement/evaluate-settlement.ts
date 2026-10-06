// The BR-RUA-032 settlement evaluator (design §8.12, D-32), shared by the live observer and the
// oracle's settlement gate G6. Samples are read in `observed_at` order (a stable sort keeps the
// given order of equal instants) up to `published_at + observation_deadline_ms`. Any activity
// restarts the stabilization window; the window starts at the first quiet sample and completes at
// an observation sample at least `stabilization_ms` later; settlement is established only when a
// quiet `pre_freeze_recheck` sample follows the completed window before the deadline. Activity in
// a recheck restarts the window with PRE_FREEZE_ACTIVITY. The first sample has no previous sample,
// so only quietness applies to it, as the observer the golden builder simulates does.

import type { StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import { activityCauses } from './settlement-activity.ts';
import type {
  SettlementAssessment,
  SettlementPolicy,
  SettlementRestart,
  SettlementRestartCause,
  SettlementSample,
} from './settlement-policy.ts';

const SUBJECT = 'BR-RUA-032';

interface TimedSample {
  readonly sample: SettlementSample;
  readonly at_ms: number;
}

/** The causes of the last active sample, and when it was observed. */
interface LastActivity {
  readonly causes: readonly SettlementRestartCause[];
  readonly at: UtcMillis;
}

/**
 * Judges settlement from samples under a policy, for a trial or probe published at `publishedAt`.
 *
 * @example
 * evaluateSettlement(samples, TRIAL_SETTLEMENT_POLICY, '2026-10-05T12:35:05.000Z' as UtcMillis).status; // 'established'
 */
export function evaluateSettlement(
  samples: readonly SettlementSample[],
  policy: SettlementPolicy,
  publishedAt: UtcMillis,
): SettlementAssessment {
  const deadlineMs = Date.parse(publishedAt) + policy.observation_deadline_ms;
  const restarts: SettlementRestart[] = [];
  let previous: SettlementSample | undefined;
  let windowStart: TimedSample | undefined;
  let quietUntil: TimedSample | undefined;
  let last: LastActivity | undefined;
  for (const timed of inObservationOrder(samples).filter((candidate) => candidate.at_ms <= deadlineMs)) {
    const { sample } = timed;
    const causes = activityCauses(sample, previous);
    previous = sample;
    const [firstCause] = causes;
    if (firstCause !== undefined) {
      const cause = sample.phase === 'pre_freeze_recheck' ? 'PRE_FREEZE_ACTIVITY' : firstCause;
      restarts.push({ at: sample.observed_at, cause });
      [windowStart, quietUntil, last] = [undefined, undefined, { causes, at: sample.observed_at }];
      continue;
    }
    if (sample.phase === 'pre_freeze_recheck' && windowStart !== undefined && quietUntil !== undefined) {
      return {
        status: 'established',
        window_start: windowStart.sample.observed_at,
        established_at: quietUntil.sample.observed_at,
        rechecked_at: sample.observed_at,
        restarts,
      };
    }
    windowStart ??= timed;
    if (sample.phase === 'observation' && timed.at_ms - windowStart.at_ms >= policy.stabilization_ms) {
      quietUntil = timed;
    }
  }
  return { status: 'not_established', reasons: notEstablishedReasons(policy, publishedAt, last), restarts };
}

function inObservationOrder(samples: readonly SettlementSample[]): readonly TimedSample[] {
  return samples
    .map((sample) => ({ sample, at_ms: Date.parse(sample.observed_at) }))
    .toSorted((a, b) => a.at_ms - b.at_ms);
}

// §8.12: the last non-quiet causes, or DEADLINE when no sample was ever active.
function notEstablishedReasons(
  policy: SettlementPolicy,
  publishedAt: UtcMillis,
  last: LastActivity | undefined,
): readonly StructuredReason[] {
  const window = `a quiet window of ${String(policy.stabilization_ms)} ms and a quiet pre-freeze recheck within ${String(policy.observation_deadline_ms)} ms of publication at ${publishedAt}`;
  if (last === undefined) {
    return [{ code: 'DEADLINE', subject: SUBJECT, detail: `no such window was observed; expected ${window}` }];
  }
  return last.causes.map((cause) => ({
    code: cause,
    subject: SUBJECT,
    detail: `the sample at ${last.at} was not quiet (${cause}); expected ${window}`,
  }));
}
