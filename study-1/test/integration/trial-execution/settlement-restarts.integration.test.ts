// AC-RUA-020 (integration, virtual time; cases: visible message, in-flight message, new correlated
// DLQ message, activity at the pre-freeze recheck): settlement is not established while activity
// appears before the freeze. Each case runs the real trial executor on a conventional CONTROL trial
// in the offline cloud; activity appears after the stabilization window has begun, the observer
// records a restart with that cause, and the window starts again after it (BR-RUA-032, D-32). The
// trial then settles and freezes, and the runner's judgement is the one the oracle re-derives.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { TrialExecutionReport } from '../../../src/trial-execution/trial-execution-ports.ts';
import { OfflineCloud } from '../../support/offline-cloud/offline-cloud.ts';
import type { RunningTrial } from '../../support/offline-cloud/offline-cloud.ts';
import {
  gateValue,
  runnerEvents,
  textField,
  trialFileBytes,
  trialLines,
  trialRecord,
} from './support/frozen-trial-files.ts';

const POLL_MS = 30_000;

interface StartedControlTrial {
  readonly cloud: OfflineCloud;
  readonly running: RunningTrial;
}

async function startControlTrial(): Promise<StartedControlTrial> {
  const cloud = new OfflineCloud('run');
  await cloud.startExecution();
  return { cloud, running: cloud.start(1) };
}

function publishedMs(cloud: OfflineCloud, trialId: Uuid4): number {
  const published = runnerEvents(cloud, trialId).find((event) => event['record_type'] === 'trial_message_published');
  assert.ok(published !== undefined, 'trial_message_published is journaled');
  return Date.parse(textField(published, 'occurred_at'));
}

// Drives to `offsetMs` after publication (the clock moves in whole steps).
async function advanceToOffset(cloud: OfflineCloud, trialId: Uuid4, offsetMs: number): Promise<void> {
  await cloud.advanceUntil(() => runnerEvents(cloud, trialId).length >= 2);
  await cloud.advanceUntil(() => cloud.time.now().getTime() >= publishedMs(cloud, trialId) + offsetMs);
}

function settlementOf(report: TrialExecutionReport): Extract<TrialExecutionReport, { kind: 'frozen' }>['settlement'] {
  assert.equal(report.kind, 'frozen');
  return report.settlement;
}

function instant(ms: number): string {
  return new Date(ms).toISOString();
}

// The runner's settlement_assessed and the oracle's G6 agree on the established window.
function assertFrozenAndAgreed(cloud: OfflineCloud, trialId: Uuid4, report: TrialExecutionReport): void {
  const assessed = runnerEvents(cloud, trialId).find((event) => event['record_type'] === 'settlement_assessed');
  const settlement = settlementOf(report);
  assert.ok(assessed !== undefined, 'settlement_assessed is journaled');
  assert.equal(assessed['status'], 'established');
  assert.deepEqual(assessed['restarts'], settlement.restarts);
  assert.equal(gateValue(trialRecord(cloud, trialId, 'oracleResult'), 'settlement'), 'verified');
}

describe('AC-RUA-020 settlement restarts on activity before freeze', () => {
  it('visible-message: a visible source message restarts the window with SOURCE_VISIBLE', async () => {
    const { cloud, running } = await startControlTrial();
    const trialId = running.plan.trial.trial_id;
    await advanceToOffset(cloud, trialId, 2 * POLL_MS + 5000);
    cloud.pump.pause();
    cloud.injectSourceMessage();
    await advanceToOffset(cloud, trialId, 3 * POLL_MS + 5000);
    cloud.drainSource();
    cloud.pump.resume();
    const report = await cloud.finish(running);

    const published = publishedMs(cloud, trialId);
    const settlement = settlementOf(report);
    assert.deepEqual(settlement.restarts, [{ at: instant(published + 3 * POLL_MS), cause: 'SOURCE_VISIBLE' }]);
    assert.equal(
      settlement.status === 'established' ? settlement.window_start : undefined,
      instant(published + 4 * POLL_MS),
    );
    assertFrozenAndAgreed(cloud, trialId, report);
  });

  it('in-flight-message: a source message held in flight restarts the window with SOURCE_IN_FLIGHT', async () => {
    const { cloud, running } = await startControlTrial();
    const trialId = running.plan.trial.trial_id;
    await advanceToOffset(cloud, trialId, 2 * POLL_MS + 5000);
    cloud.pump.pause();
    cloud.injectSourceMessage();
    const receipt = cloud.holdSourceMessage();
    await advanceToOffset(cloud, trialId, 3 * POLL_MS + 5000);
    cloud.releaseSourceMessage(receipt);
    cloud.pump.resume();
    const report = await cloud.finish(running);

    const published = publishedMs(cloud, trialId);
    const settlement = settlementOf(report);
    assert.deepEqual(settlement.restarts, [{ at: instant(published + 3 * POLL_MS), cause: 'SOURCE_IN_FLIGHT' }]);
    assert.equal(
      settlement.status === 'established' ? settlement.window_start : undefined,
      instant(published + 4 * POLL_MS),
    );
    assertFrozenAndAgreed(cloud, trialId, report);
  });

  it('new-correlated-dlq-message: a new DLQ message of the trial restarts the window with NEW_CORRELATED_DLQ_MESSAGE', async () => {
    const { cloud, running } = await startControlTrial();
    const trialId = running.plan.trial.trial_id;
    await advanceToOffset(cloud, trialId, 2 * POLL_MS + 5000);
    const body = new TextDecoder().decode(trialFileBytes(cloud, trialId, 'publishedMessage'));
    const messageId = cloud.injectDlqMessage(trialId, body);
    const report = await cloud.finish(running);

    const published = publishedMs(cloud, trialId);
    const settlement = settlementOf(report);
    assert.deepEqual(settlement.restarts, [
      { at: instant(published + 3 * POLL_MS), cause: 'NEW_CORRELATED_DLQ_MESSAGE' },
    ]);
    assert.equal(
      settlement.status === 'established' ? settlement.window_start : undefined,
      instant(published + 4 * POLL_MS),
    );
    const snapshot = trialRecord(cloud, trialId, 'dlqSnapshot');
    assert.deepEqual(
      (snapshot['messages'] as readonly JsonObject[]).map((message) => message['message_id']),
      [messageId],
    );
    assert.equal(
      runnerEvents(cloud, trialId).find((event) => event['record_type'] === 'settlement_assessed')?.['status'],
      'established',
    );
  });

  it('activity-at-pre-freeze-recheck: activity after collection restarts the window with PRE_FREEZE_ACTIVITY (D-32)', async () => {
    const { cloud, running } = await startControlTrial();
    const trialId = running.plan.trial.trial_id;
    cloud.telemetry.onNextCollection(() => {
      cloud.pump.pause();
      cloud.injectSourceMessage();
    });
    await cloud.advanceUntil(() => cloud.telemetry.collectionCount() === 1);
    const recheckAt = cloud.time.now().getTime();
    await cloud.advanceBy(5000);
    cloud.drainSource();
    cloud.pump.resume();
    const report = await cloud.finish(running);

    const settlement = settlementOf(report);
    assert.deepEqual(settlement.restarts, [{ at: instant(recheckAt), cause: 'PRE_FREEZE_ACTIVITY' }]);
    assert.ok(settlement.status === 'established' && Date.parse(settlement.window_start) > recheckAt);
    const phases = trialLines(cloud, trialId, 'settlementSamples').map((sample) => sample['phase']);
    assert.deepEqual(
      phases.filter((phase) => phase === 'pre_freeze_recheck'),
      ['pre_freeze_recheck', 'pre_freeze_recheck'],
    );
    assert.equal(cloud.telemetry.collectionCount(), 2);
    assertFrozenAndAgreed(cloud, trialId, report);
  });
});
