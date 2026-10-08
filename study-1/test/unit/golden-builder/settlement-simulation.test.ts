// The settlement observer of the scenario builder (BR-RUA-032, design §8.12, D-32): samples every
// 30 s from publication, establishment by a quiet 120 s window and a quiet pre-freeze recheck 5 s
// later, a restart when the recheck sees activity, and the last non-quiet causes as reasons when
// the 600 s deadline passes first. Activity is injected into a simulated trial's timeline.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { executionContextOf, trialIdOf } from '../../support/golden-builder/execution-files.ts';
import { linkSha256 } from '../../support/golden-builder/digest-links.ts';
import { defaultTrialPlan } from '../../support/golden-builder/golden-plan.ts';
import {
  countersJson,
  observeSettlement,
  RECHECK_AFTER_MS,
} from '../../support/golden-builder/settlement-simulation.ts';
import { publishedMs, slotStartMs } from '../../support/golden-builder/trial-context.ts';
import type { TrialContext } from '../../support/golden-builder/trial-context.ts';
import { recordText } from '../../support/golden-builder/golden-event-log.ts';
import { simulateTrial } from '../../support/golden-builder/trial-simulation.ts';
import type { SimulatedTrial } from '../../support/golden-builder/trial-simulation.ts';

const execution = executionContextOf('run');
const trialId = trialIdOf('run', 1);
const CONTEXT: TrialContext = {
  execution,
  label: 'unit/settlement',
  caller: 'conventional',
  scenario: 'CONTROL',
  trial: { trial_id: trialId, trial_manifest_sha256: linkSha256(`trials/${trialId}/trial-manifest.json`) },
  partition_key: `${execution.execution_id}#${trialId}`,
  directory: `trials/${trialId}`,
  slot_ms: slotStartMs(1),
};
const P = publishedMs(CONTEXT);

function controlTrial(): SimulatedTrial {
  return simulateTrial(CONTEXT, defaultTrialPlan('conventional', 'CONTROL'));
}

describe('observeSettlement', () => {
  it('establishes a quiet CONTROL trial at the first window and recheck', () => {
    const settlement = observeSettlement(CONTEXT, controlTrial());
    assert.deepEqual(settlement.assessment, {
      status: 'established',
      window_start: new Date(Date.UTC(2026, 9, 5, 12, 0) + P + 30_000).toISOString(),
      established_at: new Date(Date.UTC(2026, 9, 5, 12, 0) + P + 150_000).toISOString(),
      rechecked_at: new Date(Date.UTC(2026, 9, 5, 12, 0) + P + 155_000).toISOString(),
      reasons: [],
      restarts: [],
      sample_count: 6,
    });
    assert.equal(settlement.capture_ms, P + 150_000);
    assert.equal(settlement.assessed_ms, P + 155_000 + 1000);
    assert.equal(settlement.dlq_captured_ms, undefined);
    assert.deepEqual(
      settlement.samples.map((sample) => sample.fields['phase']),
      ['observation', 'observation', 'observation', 'observation', 'observation', 'pre_freeze_recheck'],
    );
  });

  it('restarts on activity in the pre-freeze recheck and establishes on the next window', () => {
    const trial = controlTrial();
    trial.timeline.addLedger(P + 150_000 + RECHECK_AFTER_MS, { provider_transaction_id: 'late' });
    const settlement = observeSettlement(CONTEXT, trial);
    assert.equal(settlement.assessment['status'], 'established');
    assert.deepEqual(settlement.assessment['restarts'], [
      { at: new Date(Date.UTC(2026, 9, 5, 12, 0) + P + 155_000).toISOString(), cause: 'PRE_FREEZE_ACTIVITY' },
    ]);
    assert.equal(settlement.capture_ms, P + 300_000);
  });

  it('is not established by the deadline, giving the last non-quiet causes', () => {
    const trial = controlTrial();
    trial.timeline.addQueueSpan({ state: 'in_flight', from_ms: P, until_ms: P + 590_000 });
    const settlement = observeSettlement(CONTEXT, trial);
    assert.equal(settlement.assessment['status'], 'not_established');
    const reasons = settlement.assessment['reasons'] as readonly JsonObject[];
    assert.deepEqual(
      reasons.map((reason) => reason['code']),
      ['SOURCE_IN_FLIGHT'],
    );
    assert.match(
      reasons[0] === undefined ? '' : recordText(reasons[0], 'detail'),
      /was not quiet \(SOURCE_IN_FLIGHT\)/,
    );
    assert.equal(settlement.capture_ms, P + 600_000);
    assert.equal(settlement.assessed_ms, P + 601_000);
    assert.equal(settlement.samples.length, 20);
  });

  it('stops before a recheck that would fall past the deadline', () => {
    const trial = controlTrial();
    trial.timeline.addQueueSpan({ state: 'in_flight', from_ms: P, until_ms: P + 470_000 });
    const settlement = observeSettlement(CONTEXT, trial);
    assert.equal(settlement.assessment['status'], 'not_established');
    assert.equal(
      settlement.samples.every((sample) => sample.fields['phase'] === 'observation'),
      true,
    );
  });

  it('writes not-applicable markers for the probe', () => {
    const probe: TrialContext = { ...CONTEXT, caller: 'probe', scenario: 'COMMIT_THEN_TIMEOUT', directory: 'probe' };
    const { trial: _, ...withoutTrial } = probe;
    const settlement = observeSettlement(
      withoutTrial,
      simulateTrial(withoutTrial, defaultTrialPlan('probe', 'COMMIT_THEN_TIMEOUT')),
    );
    assert.equal(settlement.assessment['status'], 'established');
    const sample = settlement.samples[0]?.fields ?? {};
    assert.deepEqual(
      [sample['source_queue'], sample['dlq'], sample['inner_executions_terminal']],
      ['not_applicable', 'not_applicable', 'not_applicable'],
    );
  });
});

describe('countersJson', () => {
  it('copies counters and passes the marker through', () => {
    assert.deepEqual(countersJson({ visible: 1, in_flight: 2, delayed: 3 }), { visible: 1, in_flight: 2, delayed: 3 });
    assert.equal(countersJson('not_applicable'), 'not_applicable');
  });
});
