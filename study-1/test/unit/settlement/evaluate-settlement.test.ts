// Design §8.12 and D-32: the settlement evaluator over hand-made sample series (window start and
// completion, restarts in the window and at the recheck, the deadline, sample order) and over the
// samples the golden builder's observer froze, whose `settlement_assessed` it must reproduce.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateSettlement } from '../../../src/settlement/evaluate-settlement.ts';
import { PROBE_SETTLEMENT_POLICY, TRIAL_SETTLEMENT_POLICY } from '../../../src/settlement/settlement-policy.ts';
import type { SettlementAssessment } from '../../../src/settlement/settlement-policy.ts';
import { eventsOfType, partitionEvents } from '../../../src/treatment-fidelity/subject-events.ts';
import type { BaseScenarioId, TrialPlan } from '../../support/golden-builder/golden-plan.ts';
import { builtEvidence } from '../trial-oracle/support/built-trials.ts';
import { at, PUBLISHED_AT, quietSample, quietSeries, recheck } from './support/settlement-samples.ts';

function established(window: number, until: number, rechecked: number): Partial<SettlementAssessment> {
  return { status: 'established', window_start: at(window), established_at: at(until), rechecked_at: at(rechecked) };
}

function judged(samples: Parameters<typeof evaluateSettlement>[0]): SettlementAssessment {
  return evaluateSettlement(samples, TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT);
}

describe('the settlement policies', () => {
  it('are the OR-RUA-002 trial values and the OR-RUA-004 probe values', () => {
    assert.deepEqual(TRIAL_SETTLEMENT_POLICY, {
      stabilization_ms: 120_000,
      observation_deadline_ms: 600_000,
      poll_interval_ms: 30_000,
    });
    assert.deepEqual(PROBE_SETTLEMENT_POLICY, {
      stabilization_ms: 120_000,
      observation_deadline_ms: 600_000,
      poll_interval_ms: 30_000,
    });
  });
});

describe('evaluateSettlement', () => {
  it('establishes settlement after 120 s of quiet and a quiet recheck', () => {
    const result = judged([...quietSeries(30_000, 150_000), recheck(155_000)]);
    assert.deepEqual(result, { ...established(30_000, 150_000, 155_000), restarts: [] });
  });

  it('does not complete a window shorter than the stabilization interval', () => {
    const result = judged([...quietSeries(30_000, 120_000), recheck(125_000)]);
    assert.equal(result.status, 'not_established');
  });

  it('starts the window at the first quiet sample after any activity', () => {
    const samples = [
      quietSample(30_000, { processing_terminal: false }),
      quietSample(60_000, { source_queue: { visible: 0, in_flight: 1, delayed: 0 } }),
      ...quietSeries(90_000, 210_000),
      recheck(215_000),
    ];
    const result = judged(samples);
    assert.deepEqual(result, {
      ...established(90_000, 210_000, 215_000),
      restarts: [
        { at: at(30_000), cause: 'PROCESSING_NOT_TERMINAL' },
        { at: at(60_000), cause: 'SOURCE_IN_FLIGHT' },
      ],
    });
  });

  it('restarts the window on activity inside it', () => {
    const samples = [
      ...quietSeries(30_000, 90_000),
      quietSample(120_000, { correlated_event_watermark: 6 }),
      ...quietSeries(150_000, 270_000).map((sample) => ({ ...sample, correlated_event_watermark: 6 })),
      recheck(275_000, { correlated_event_watermark: 6 }),
    ];
    const result = judged(samples);
    assert.deepEqual(result, {
      ...established(150_000, 270_000, 275_000),
      restarts: [{ at: at(120_000), cause: 'CORRELATED_JOURNAL_ACTIVITY' }],
    });
  });

  it('restarts with PRE_FREEZE_ACTIVITY when the recheck is active, and settles on a later recheck', () => {
    const samples = [
      ...quietSeries(30_000, 150_000),
      recheck(155_000, { ledger_item_count: 2 }),
      ...quietSeries(180_000, 300_000).map((sample) => ({ ...sample, ledger_item_count: 2 })),
      recheck(305_000, { ledger_item_count: 2 }),
    ];
    const result = judged(samples);
    assert.deepEqual(result, {
      ...established(180_000, 300_000, 305_000),
      restarts: [{ at: at(155_000), cause: 'PRE_FREEZE_ACTIVITY' }],
    });
  });

  it('reports the last active causes when the deadline passes', () => {
    const samples = [
      ...quietSeries(30_000, 90_000),
      quietSample(120_000, { provider_active_calls: 1, treatment_terminal: false }),
      ...quietSeries(150_000, 210_000),
    ];
    const result = judged(samples);
    assert.equal(result.status, 'not_established');
    assert.deepEqual(
      result.reasons.map((reason) => [reason.code, reason.subject]),
      [
        ['PROVIDER_ACTIVE', 'BR-RUA-032'],
        ['TREATMENT_NOT_TERMINAL', 'BR-RUA-032'],
      ],
    );
    assert.deepEqual(result.restarts, [{ at: at(120_000), cause: 'PROVIDER_ACTIVE' }]);
  });

  it('reports DEADLINE when no sample was ever active', () => {
    for (const samples of [[], quietSeries(30_000, 90_000)]) {
      const result = judged(samples);
      assert.equal(result.status, 'not_established');
      assert.deepEqual(
        result.reasons.map((reason) => reason.code),
        ['DEADLINE'],
      );
      assert.match(
        result.reasons[0]?.detail ?? '',
        /120000 ms .* 600000 ms of publication at 2026-10-05T12:00:05\.000Z/,
      );
    }
  });

  it('ignores samples after the observation deadline, but counts one exactly at it', () => {
    const late = judged([...quietSeries(480_000, 600_000), recheck(605_000)]);
    assert.equal(late.status, 'not_established');
    const atDeadline = judged([...quietSeries(450_000, 570_000), recheck(600_000)]);
    assert.deepEqual(atDeadline, { ...established(450_000, 570_000, 600_000), restarts: [] });
  });

  it('reads samples in observed_at order whatever the given order', () => {
    const ordered = [...quietSeries(30_000, 150_000), recheck(155_000)];
    assert.deepEqual(judged(ordered.toReversed()), judged(ordered));
  });

  it('lets a quiet recheck start a window but never complete one', () => {
    const samples = [recheck(10_000), ...quietSeries(40_000, 130_000), recheck(135_000)];
    assert.deepEqual(judged(samples), { ...established(10_000, 130_000, 135_000), restarts: [] });
  });

  it('ends the window at the last quiet observation before the recheck', () => {
    const samples = [...quietSeries(30_000, 210_000), recheck(215_000)];
    assert.deepEqual(judged(samples), { ...established(30_000, 210_000, 215_000), restarts: [] });
  });
});

const BUILDER_BASES: readonly BaseScenarioId[] = [
  'run-conventional-control',
  'run-durable-control',
  'run-conventional-treatment',
  'run-durable-treatment',
  'validation-conventional-control',
  'validation-durable-treatment',
];

describe('evaluateSettlement over the golden builder observer', () => {
  for (const base of BUILDER_BASES) {
    it(`reproduces the frozen settlement_assessed of ${base}`, () => {
      assertReproduces(base, undefined);
    });
  }

  it('reproduces a settlement not established by the deadline', () => {
    const plan: TrialPlan = {
      deliveries: [{ attempts: [{ behavior: 'commit_failed' }] }],
      processing: 'active_at_deadline',
    };
    const assessment = assertReproduces('run-conventional-control', plan);
    assert.equal(assessment.status, 'not_established');
  });
});

function assertReproduces(base: BaseScenarioId, plan: TrialPlan | undefined): SettlementAssessment {
  const evidence = builtEvidence(plan === undefined ? { base } : { base, plan });
  const events = partitionEvents(evidence);
  const published = eventsOfType(events, 'trial_message_published')[0]?.record.occurred_at;
  const assessed = eventsOfType(events, 'settlement_assessed')[0]?.record;
  assert.ok(published !== undefined && assessed !== undefined, `${base} has a publication and an assessment`);
  const samples = evidence.observations.settlement_samples.map((located) => located.record);
  const result = evaluateSettlement(samples, TRIAL_SETTLEMENT_POLICY, published);
  assert.equal(result.status, assessed.status);
  assert.deepEqual(result.restarts, assessed.restarts);
  if (result.status === 'established' && assessed.status === 'established') {
    assert.deepEqual(
      [result.window_start, result.established_at, result.rechecked_at],
      [assessed.window_start, assessed.established_at, assessed.rechecked_at],
    );
  }
  if (result.status === 'not_established') {
    assert.deepEqual(
      result.reasons.map((reason) => reason.code),
      assessed.reasons.map((reason) => reason.code),
    );
  }
  return result;
}
