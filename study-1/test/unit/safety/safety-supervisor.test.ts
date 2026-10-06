// Real-time safety supervision (BR-RUA-046, AC-RUA-049): deadlines on the monotonic clock, wall
// clock only for timestamps, the active duration frozen when active work ends.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROBE_SAFETY, RUN_SAFETY } from '../../../src/safety/safety-limits.ts';
import { SafetySupervisor } from '../../../src/safety/safety-supervisor.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

const START = Date.parse('2026-10-06T12:00:00.000Z');

function supervised(limits = PROBE_SAFETY): {
  readonly time: VirtualTimeScheduler;
  readonly supervisor: SafetySupervisor;
} {
  const time = new VirtualTimeScheduler({ wallEpochMs: START, monotonicOriginNs: 7_000_000_000n });
  const supervisor = new SafetySupervisor({ monotonic: time, wall: time, limits, startedNs: time.nowNs() });
  return { time, supervisor };
}

describe('SafetySupervisor', () => {
  it('allows trials until the active deadline, which itself counts as reached', async () => {
    const { time, supervisor } = supervised();
    assert.equal(supervisor.mayStartTrial(), true);
    await time.advanceBy(599_999);
    assert.equal(supervisor.activeDeadlineReached(), false);
    assert.equal(supervisor.mayStartTrial(), true);
    await time.advanceBy(1);
    assert.equal(supervisor.activeDeadlineReached(), true);
    assert.equal(supervisor.mayStartTrial(), false);
  });

  it('reports the total target exceeded only past it', async () => {
    const { time, supervisor } = supervised();
    await time.advanceBy(1_200_000);
    assert.equal(supervisor.totalTargetExceeded(), false);
    await time.advanceBy(1);
    assert.equal(supervisor.totalTargetExceeded(), true);
  });

  it('ignores wall-clock steps when measuring elapsed time', async () => {
    const { time, supervisor } = supervised();
    time.skewWall(10_000_000);
    assert.equal(supervisor.activeDeadlineReached(), false);
    await time.advanceBy(1_000);
    assert.equal(supervisor.checks()[1].observed, '1000 ms');
    assert.equal(supervisor.checks()[1].checked_at, '2026-10-06T14:46:41.000Z');
  });

  it('stops new trials once active work ended, and freezes the active duration', async () => {
    const { time, supervisor } = supervised(RUN_SAFETY);
    await time.advanceBy(12_000);
    supervisor.markActiveEnded();
    assert.equal(supervisor.mayStartTrial(), false);
    await time.advanceBy(5_000);
    supervisor.markActiveEnded();
    const [active, total] = supervisor.checks();
    assert.deepEqual(active, {
      boundary: 'ACTIVE_TIME',
      declared_limit: '4500000 ms',
      observed: '12000 ms',
      result: 'within_limits',
      evidence_refs: [],
      checked_at: '2026-10-06T12:00:17.000Z',
    });
    assert.deepEqual(total, {
      boundary: 'TOTAL_TIME',
      declared_limit: '5400000 ms',
      observed: '17000 ms',
      result: 'within_limits',
      evidence_refs: [],
      checked_at: '2026-10-06T12:00:17.000Z',
    });
  });

  it('marks a duration above its limit breached, and one at its limit within limits', async () => {
    const { time, supervisor } = supervised();
    await time.advanceBy(600_000);
    assert.deepEqual(
      supervisor.checks().map((check) => [check.boundary, check.observed, check.result]),
      [
        ['ACTIVE_TIME', '600000 ms', 'within_limits'],
        ['TOTAL_TIME', '600000 ms', 'within_limits'],
      ],
    );
    await time.advanceBy(600_001);
    assert.deepEqual(
      supervisor.checks().map((check) => [check.boundary, check.observed, check.result]),
      [
        ['ACTIVE_TIME', '1200001 ms', 'breached'],
        ['TOTAL_TIME', '1200001 ms', 'breached'],
      ],
    );
  });

  it('rounds elapsed nanoseconds down to whole milliseconds', async () => {
    const { time, supervisor } = supervised();
    await time.advanceBy(1.9);
    assert.equal(supervisor.checks()[0].observed, '1 ms');
  });

  it('clamps a monotonic reading before the start to zero elapsed time', () => {
    const time = new VirtualTimeScheduler({ wallEpochMs: START, monotonicOriginNs: 0n });
    const supervisor = new SafetySupervisor({
      monotonic: time,
      wall: time,
      limits: PROBE_SAFETY,
      startedNs: 5_000_000n,
    });
    assert.equal(supervisor.checks()[0].observed, '0 ms');
    assert.equal(supervisor.mayStartTrial(), true);
  });
});
