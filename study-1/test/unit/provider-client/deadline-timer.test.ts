// DeadlineTimer and SettlementArbiter (BR-RUA-011, BR-RUA-023; RK-03): the timer fires once, only
// after at least the deadline of monotonic time since the origin, re-arming for the remainder
// after an early firing; the arbiter lets the first claim win forever.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeadlineTimer, delayMsFor } from '../../../src/provider-client/deadline-timer.ts';
import { SettlementArbiter } from '../../../src/provider-client/settlement-arbiter.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

const MS = 1_000_000n;
const ORIGIN_NS = 50n * MS;

function setup(): { readonly time: VirtualTimeScheduler; readonly timer: DeadlineTimer; readonly fired: bigint[] } {
  const time = new VirtualTimeScheduler({ wallEpochMs: 0, monotonicOriginNs: ORIGIN_NS });
  return { time, timer: new DeadlineTimer({ monotonic: time, scheduler: time }), fired: [] };
}

describe('delayMsFor', () => {
  it('rounds the remaining nanoseconds up to whole milliseconds and never goes negative', () => {
    assert.equal(delayMsFor(3_000n * MS), 3000);
    assert.equal(delayMsFor(MS), 1);
    assert.equal(delayMsFor(MS + 1n), 2);
    assert.equal(delayMsFor(1n), 1);
    assert.equal(delayMsFor(0n), 0);
    assert.equal(delayMsFor(-5n), 0);
  });
});

describe('DeadlineTimer', () => {
  it('fires exactly at the deadline with the monotonic elapsed time', async () => {
    const { time, timer, fired } = setup();
    timer.start(time.nowNs(), 3_000n * MS, (elapsed) => fired.push(elapsed));
    await time.advanceBy(2_999);
    assert.deepEqual(fired, []);
    await time.advanceBy(1);
    assert.deepEqual(fired, [3_000n * MS]);
    await time.advanceUntilIdle();
    assert.deepEqual(fired, [3_000n * MS]);
  });

  it('never fires synchronously inside start, even for a deadline already reached', async () => {
    const { time, timer, fired } = setup();
    timer.start(time.nowNs() - 10n * MS, 0n, (elapsed) => fired.push(elapsed));
    assert.deepEqual(fired, []);
    assert.equal(time.pendingTimerCount(), 1);
    await time.advanceBy(0);
    assert.deepEqual(fired, [10n * MS]);
  });

  it('counts the deadline from the origin, not from the start call', async () => {
    const { time, timer, fired } = setup();
    const origin = time.nowNs();
    await time.advanceBy(1_000);
    timer.start(origin, 3_000n * MS, (elapsed) => fired.push(elapsed));
    await time.advanceBy(1_999);
    assert.deepEqual(fired, []);
    await time.advanceBy(1);
    assert.deepEqual(fired, [3_000n * MS]);
  });

  it('re-arms after an early firing until the elapsed time reaches the deadline (RK-03)', async () => {
    const { time, timer, fired } = setup();
    time.fireEarlyBy(2n * MS);
    timer.start(time.nowNs(), 3_000n * MS, (elapsed) => fired.push(elapsed));
    await time.advanceBy(2_998);
    assert.deepEqual(fired, []);
    assert.equal(time.pendingTimerCount(), 1);
    await time.advanceBy(2);
    assert.deepEqual(fired, [3_000n * MS]);
  });

  it('cancel stops the first arming and a re-armed one', async () => {
    const first = setup();
    first.timer.start(first.time.nowNs(), 3_000n * MS, (elapsed) => first.fired.push(elapsed)).cancel();
    await first.time.advanceUntilIdle();
    assert.deepEqual(first.fired, []);

    const rearmed = setup();
    rearmed.time.fireEarlyBy(5n * MS);
    const handle = rearmed.timer.start(rearmed.time.nowNs(), 3_000n * MS, (elapsed) => rearmed.fired.push(elapsed));
    await rearmed.time.advanceBy(2_996);
    handle.cancel();
    assert.equal(rearmed.time.pendingTimerCount(), 0);
    await rearmed.time.advanceUntilIdle();
    assert.deepEqual(rearmed.fired, []);
  });

  it('refuses a negative deadline', () => {
    const { time, timer } = setup();
    assert.throws(() => timer.start(time.nowNs(), -1n, () => undefined), {
      name: 'RangeError',
      message: 'deadline -1 ns; expected a nonnegative number of nanoseconds',
    });
  });
});

describe('SettlementArbiter', () => {
  it('has no winner until the first claim, which wins forever', () => {
    const arbiter = new SettlementArbiter();
    assert.equal(arbiter.winner(), undefined);
    assert.equal(arbiter.claim('TIMER'), true);
    assert.equal(arbiter.claim('TRANSPORT'), false);
    assert.equal(arbiter.claim('TIMER'), false);
    assert.equal(arbiter.winner(), 'TIMER');
  });

  it('lets the transport win the same way', () => {
    const arbiter = new SettlementArbiter();
    assert.equal(arbiter.claim('TRANSPORT'), true);
    assert.equal(arbiter.claim('TIMER'), false);
    assert.equal(arbiter.winner(), 'TRANSPORT');
  });
});
