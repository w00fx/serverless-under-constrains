// Conformance of SelfAdvancingSleeper to the Sleeper contract on virtual time: a sleep resolves
// after exactly its duration of monotonic and wall time, an early wake-up is one-shot (RK-03),
// a stalled sleeper resolves without time passing, and requests are recorded.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SelfAdvancingSleeper } from '../../../support/cleanup/self-advancing-sleeper.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';

describe('SelfAdvancingSleeper conformance', () => {
  it('advances monotonic and wall time by the requested duration', async () => {
    const time = new VirtualTimeScheduler({ wallEpochMs: 0 });
    const sleeper = new SelfAdvancingSleeper(time);
    await sleeper.sleep(1_500);
    assert.equal(time.nowNs(), 1_500_000_000n);
    assert.equal(time.now().getTime(), 1_500);
    assert.deepEqual(sleeper.requests(), [1_500]);
  });

  it('wakes early once, never before now, and stalls when told', async () => {
    const time = new VirtualTimeScheduler({ wallEpochMs: 0 });
    const sleeper = new SelfAdvancingSleeper(time);
    sleeper.wakeEarlyBy(400);
    await sleeper.sleep(1_000);
    await sleeper.sleep(1_000);
    assert.equal(time.nowNs(), 1_600_000_000n);
    sleeper.wakeEarlyBy(5_000);
    await sleeper.sleep(1_000);
    assert.equal(time.nowNs(), 1_600_000_000n);
    sleeper.stall();
    await sleeper.sleep(10_000);
    assert.equal(time.nowNs(), 1_600_000_000n);
    assert.deepEqual(sleeper.requests(), [1_000, 1_000, 1_000, 10_000]);
  });
});
