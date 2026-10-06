// Design §12.5 for `evaluateSettlement` (BR-RUA-032, D-32): over arbitrary sample series, settlement
// is never established before 120 s of quiet followed by a quiet pre-freeze recheck within the
// deadline; any activity restarts the window, and every active sample read is recorded as a
// restart. Instants are distinct, so the observation order is the instant order.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { evaluateSettlement } from '../../../src/settlement/evaluate-settlement.ts';
import { activityCauses } from '../../../src/settlement/settlement-activity.ts';
import { TRIAL_SETTLEMENT_POLICY } from '../../../src/settlement/settlement-policy.ts';
import type { SettlementSample } from '../../../src/settlement/settlement-policy.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { PUBLISHED_AT, PUBLISHED_MS, quietSample } from '../../unit/settlement/support/settlement-samples.ts';

const DEADLINE_MS = PUBLISHED_MS + TRIAL_SETTLEMENT_POLICY.observation_deadline_ms;

/** Changes that make a sample not quiet by itself, one per restart cause family. */
const NOT_QUIET: readonly Partial<SettlementSample>[] = [
  { source_queue: { visible: 1, in_flight: 0, delayed: 0 } },
  { source_queue: { visible: 0, in_flight: 1, delayed: 0 } },
  { source_queue: 'unavailable' },
  { dlq: { visible: 1, in_flight: 0, delayed: 0 } },
  { provider_held_barriers: 1 },
  { processing_terminal: false },
  { publication_stopped: false },
  { inner_executions_terminal: false },
  { treatment_terminal: false },
  { ledger_snapshot_possible: false },
];

/** Changes that are activity only against the previous sample. */
const PERTURBATIONS: readonly Partial<SettlementSample>[] = [
  ...NOT_QUIET,
  { correlated_dlq_message_ids: ['m-1'], dlq_captured_message_ids: ['m-1'] },
  { correlated_event_watermark: 6 },
  { ledger_item_count: 2 },
];

/** One poll: how long after the previous one (5 s steps), its phase (one in five a recheck), and a change in one of six. */
const pollArbitrary = fc.record({
  gap: fc.integer({ min: 1, max: 9 }).map((steps) => steps * 5000),
  recheck: fc.integer({ min: 0, max: 4 }).map((draw) => draw === 0),
  perturbation: fc.oneof(
    { weight: 5, arbitrary: fc.constant(undefined) },
    { weight: 1, arbitrary: fc.constantFrom(...PERTURBATIONS) },
  ),
});

// Polls accumulate from a start offset, so instants are distinct and mostly 30 s apart; the series
// is then given in a shuffled order the evaluator must undo.
const seriesArbitrary = fc
  .tuple(fc.integer({ min: 0, max: 12 }), fc.array(pollArbitrary, { maxLength: 40, size: 'medium' }))
  .map(([start, polls]) => {
    let offset = start * 5000;
    return polls.map(({ gap, recheck, perturbation }) => {
      offset += gap;
      return quietSample(offset, { phase: recheck ? 'pre_freeze_recheck' : 'observation', ...(perturbation ?? {}) });
    });
  })
  .chain((series) => fc.shuffledSubarray(series, { minLength: series.length, maxLength: series.length }));

function inOrder(samples: readonly SettlementSample[]): readonly SettlementSample[] {
  return samples.toSorted((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
}

describe('evaluateSettlement over arbitrary sample series', () => {
  it('is never established before a quiet stabilization window and a quiet recheck', () => {
    fc.assert(
      fc.property(seriesArbitrary, (samples) => {
        const result = evaluateSettlement(samples, TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT);
        if (result.status !== 'established') {
          assert.ok(result.reasons.length > 0);
          return;
        }
        const windowMs = Date.parse(result.window_start);
        const untilMs = Date.parse(result.established_at);
        const recheckMs = Date.parse(result.rechecked_at);
        assert.ok(untilMs - windowMs >= TRIAL_SETTLEMENT_POLICY.stabilization_ms);
        assert.ok(recheckMs > untilMs && recheckMs <= DEADLINE_MS);
        const ordered = inOrder(samples);
        const recheck = ordered.find((sample) => sample.observed_at === result.rechecked_at);
        assert.equal(recheck?.phase, 'pre_freeze_recheck');
        assert.equal(ordered.find((sample) => sample.observed_at === result.established_at)?.phase, 'observation');
        for (const [index, sample] of ordered.entries()) {
          const instant = Date.parse(sample.observed_at);
          if (instant >= windowMs && instant <= recheckMs) {
            assert.deepEqual(activityCauses(sample, ordered[index - 1]), [], sample.observed_at);
          }
        }
      }),
      fuzzParameters(),
    );
  });

  it('records every active sample it reads as a restart', () => {
    fc.assert(
      fc.property(seriesArbitrary, (samples) => {
        const result = evaluateSettlement(samples, TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT);
        const endMs = result.status === 'established' ? Date.parse(result.rechecked_at) : DEADLINE_MS;
        const ordered = inOrder(samples);
        const expected = ordered.flatMap((sample, index) => {
          const [cause] = activityCauses(sample, ordered[index - 1]);
          if (cause === undefined || Date.parse(sample.observed_at) > endMs) {
            return [];
          }
          return [
            { at: sample.observed_at, cause: sample.phase === 'pre_freeze_recheck' ? 'PRE_FREEZE_ACTIVITY' : cause },
          ];
        });
        assert.deepEqual(result.restarts, expected);
      }),
      fuzzParameters(),
    );
  });

  it('restarts the window when activity is inserted inside it', () => {
    fc.assert(
      fc.property(seriesArbitrary, fc.constantFrom(...NOT_QUIET), (samples, perturbation) => {
        const result = evaluateSettlement(samples, TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT);
        if (result.status !== 'established') {
          return;
        }
        const insertedMs = Date.parse(result.window_start) + 2500;
        const active = quietSample(insertedMs - PUBLISHED_MS, perturbation);
        const after = evaluateSettlement([...samples, active], TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT);
        assert.ok(after.status === 'not_established' || Date.parse(after.window_start) > insertedMs);
      }),
      fuzzParameters(),
    );
  });
});
