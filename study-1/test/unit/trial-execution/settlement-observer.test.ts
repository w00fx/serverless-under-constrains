// The observer's pure parts (BR-RUA-032, D-32): when a stabilization window is complete, judged by
// the §8.12 evaluator itself, and where the next poll falls on the publication grid.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TRIAL_SETTLEMENT_POLICY } from '../../../src/settlement/settlement-policy.ts';
import { nextPollMs, samplesOf, windowComplete } from '../../../src/trial-execution/settlement-observer.ts';
import type { SettlementReading } from '../../../src/trial-execution/settlement-reading.ts';
import { PUBLISHED_AT, quietSample } from './support/trial-execution-fixtures.ts';

const publishedMs = Date.parse(PUBLISHED_AT);

describe('windowComplete', () => {
  it('is false without samples and while the quiet run is shorter than the stabilization interval', () => {
    assert.equal(windowComplete([], TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT), false);
    const short = [30_000, 60_000, 90_000, 120_000].map((offset) => quietSample(offset));
    assert.equal(windowComplete(short, TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT), false);
  });

  it('is true once quiet samples span 120 s', () => {
    const quiet = [30_000, 60_000, 90_000, 120_000, 150_000].map((offset) => quietSample(offset));
    assert.equal(windowComplete(quiet, TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT), true);
  });

  it('is false when the last sample is active, or the window lies past the deadline', () => {
    const active = [30_000, 60_000, 90_000, 120_000].map((offset) => quietSample(offset));
    const visible = quietSample(150_000, { source_queue: { visible: 1, in_flight: 0, delayed: 0 } });
    assert.equal(windowComplete([...active, visible], TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT), false);
    const late = [500_000, 530_000, 560_000, 590_000, 620_000].map((offset) => quietSample(offset));
    assert.equal(windowComplete(late, TRIAL_SETTLEMENT_POLICY, PUBLISHED_AT), false);
  });
});

describe('nextPollMs', () => {
  it('is the first grid point after now, never earlier than publication plus one interval', () => {
    assert.equal(nextPollMs(publishedMs, publishedMs, TRIAL_SETTLEMENT_POLICY), publishedMs + 30_000);
    assert.equal(nextPollMs(publishedMs, publishedMs - 5000, TRIAL_SETTLEMENT_POLICY), publishedMs + 30_000);
    assert.equal(nextPollMs(publishedMs, publishedMs + 30_000, TRIAL_SETTLEMENT_POLICY), publishedMs + 60_000);
    assert.equal(nextPollMs(publishedMs, publishedMs + 31_000, TRIAL_SETTLEMENT_POLICY), publishedMs + 60_000);
  });
});

describe('samplesOf', () => {
  it('keeps each round sample in order', () => {
    const rounds = [quietSample(30_000), quietSample(60_000)].map(
      (sample) => ({ sample, source_observation: {}, dlq_observation: {}, failures: [] }) satisfies SettlementReading,
    );
    assert.deepEqual(
      samplesOf(rounds),
      rounds.map((round) => round.sample),
    );
  });
});
