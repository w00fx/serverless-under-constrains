// P6 late monitoring (design §10.2; BR-RUA-043; AC-RUA-049): the window stays open for at least
// 120 s on the injected clock, consults the gate at every poll, and an interruption shortens it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecutionGate } from '../../../src/execution-lifecycle/execution-gate.ts';
import { LateEvidenceMonitor, MONITORING_POLL_MS } from '../../../src/execution-lifecycle/late-monitoring.ts';
import { SelfAdvancingSleeper } from '../../support/cleanup/self-advancing-sleeper.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { ScriptedExecutionLease } from '../../integration/execution-lifecycle/fakes/scripted-execution-lease.ts';
import { ScriptedExecutionSafety } from '../../integration/execution-lifecycle/fakes/scripted-execution-safety.ts';
import { lifecycleServices } from '../../integration/execution-lifecycle/support/execution-fixtures.ts';

const EPOCH_MS = Date.UTC(2026, 9, 5, 12, 0, 0, 0);

function world(): { time: VirtualTimeScheduler; sleeper: SelfAdvancingSleeper; gate: ExecutionGate } {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
  const gate = new ExecutionGate(new ScriptedExecutionLease());
  gate.arm(new ScriptedExecutionSafety());
  return { time, sleeper: new SelfAdvancingSleeper(time), gate };
}

describe('LateEvidenceMonitor', () => {
  it('is skipped until it runs', () => {
    const { time } = world();
    assert.deepEqual(new LateEvidenceMonitor(lifecycleServices(time).services).monitoring(), { outcome: 'skipped' });
  });

  it('completes after exactly 120 s, polling every 10 s', async () => {
    const { time, sleeper, gate } = world();
    const monitor = new LateEvidenceMonitor(lifecycleServices(time, sleeper).services);
    const outcome = await monitor.observe(gate);
    assert.deepEqual(outcome, {
      outcome: 'complete',
      started_at: '2026-10-05T12:00:00.000Z',
      ended_at: '2026-10-05T12:02:00.000Z',
    });
    assert.deepEqual(monitor.monitoring(), outcome);
    assert.deepEqual(
      sleeper.requests(),
      Array.from({ length: 12 }, () => MONITORING_POLL_MS),
    );
  });

  it('sleeps only what is left of the window after an early wake', async () => {
    const { time, sleeper, gate } = world();
    sleeper.wakeEarlyBy(4_000);
    const outcome = await new LateEvidenceMonitor(lifecycleServices(time, sleeper).services).observe(gate);
    assert.equal(outcome.outcome, 'complete');
    assert.deepEqual(sleeper.requests().slice(-2), [10_000, 4_000]);
  });

  it('keeps the window open for 120 monotonic seconds when the wall clock steps forward', async () => {
    const { time, sleeper, gate } = world();
    time.schedule(30_000, () => time.skewWall(60_000));
    const startedNs = time.nowNs();
    const outcome = await new LateEvidenceMonitor(lifecycleServices(time, sleeper).services).observe(gate);
    assert.equal(outcome.outcome, 'complete');
    assert.equal(time.nowNs() - startedNs, 120_000_000_000n, 'the real window is never cut short');
    assert.equal(outcome.outcome === 'complete' && outcome.ended_at, '2026-10-05T12:03:00.000Z');
  });

  it('keeps the window open until the recorded wall times span 120 s when the wall clock steps back', async () => {
    const { time, sleeper, gate } = world();
    time.schedule(30_000, () => time.skewWall(-20_000));
    const startedNs = time.nowNs();
    const outcome = await new LateEvidenceMonitor(lifecycleServices(time, sleeper).services).observe(gate);
    assert.deepEqual(outcome, {
      outcome: 'complete',
      started_at: '2026-10-05T12:00:00.000Z',
      ended_at: '2026-10-05T12:02:00.000Z',
    });
    assert.equal(time.nowNs() - startedNs, 140_000_000_000n);
  });

  it('is shortened by an interruption during the window', async () => {
    const { time, sleeper, gate } = world();
    time.schedule(35_000, () => gate.abort('SIGINT'));
    const monitor = new LateEvidenceMonitor(lifecycleServices(time, sleeper).services);
    const outcome = await monitor.observe(gate);
    assert.deepEqual(outcome, {
      outcome: 'shortened',
      started_at: '2026-10-05T12:00:00.000Z',
      ended_at: '2026-10-05T12:00:40.000Z',
    });
    assert.equal(monitor.monitoring().outcome, 'shortened');
  });

  it('is shortened at once when the execution is already interrupted', async () => {
    const { time, sleeper, gate } = world();
    gate.abort('SIGINT');
    const outcome = await new LateEvidenceMonitor(lifecycleServices(time, sleeper).services).observe(gate);
    assert.equal(outcome.outcome, 'shortened');
    assert.deepEqual(sleeper.requests(), []);
  });
});
