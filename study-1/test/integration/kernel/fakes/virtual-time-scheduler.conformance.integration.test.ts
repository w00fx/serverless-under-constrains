// Conformance of VirtualTimeScheduler with the real Node time sources it replaces (design §12.2).
// The same contract runs against Date, process.hrtime.bigint() and setTimeout, so the fake
// cannot drift into behavior the platform does not have. Sources: Node.js timers documentation
// (timers fire no earlier than the delay is a guarantee only for the minimum delay; equal-delay
// timers run in scheduling order) and process.hrtime.bigint() (monotonic, arbitrary origin).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MonotonicClock, Sleeper, TimerScheduler, WallClock } from '../../../../src/record-contract/primitives.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';

type TimeSource = WallClock & MonotonicClock & TimerScheduler & Sleeper;

interface ContractSubject {
  readonly name: string;
  readonly create: () => TimeSource;
  /** Lets `ms` of time pass for this subject (virtual advance or a real wait). */
  readonly pass: (source: TimeSource, ms: number) => Promise<void>;
}

class NodeTimeReference implements TimeSource {
  now(): Date {
    return new Date();
  }

  nowNs(): bigint {
    return process.hrtime.bigint();
  }

  schedule(delayMs: number, callback: () => void): { cancel(): void } {
    const timer = setTimeout(callback, delayMs);
    return {
      cancel: (): void => {
        clearTimeout(timer);
      },
    };
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const subjects: readonly ContractSubject[] = [
  {
    name: 'node reference',
    create: () => new NodeTimeReference(),
    pass: (_source, ms) => new Promise((resolve) => setTimeout(resolve, ms + 15)),
  },
  {
    name: 'VirtualTimeScheduler',
    create: () => new VirtualTimeScheduler({ wallEpochMs: Date.UTC(2026, 9, 5), monotonicOriginNs: 123_456_789n }),
    pass: (source, ms) => (source as VirtualTimeScheduler).advanceBy(ms),
  },
];

for (const subject of subjects) {
  describe(`time source contract: ${subject.name}`, () => {
    it('keeps monotonic time non-decreasing and wall time a valid Date', async () => {
      const source = subject.create();
      const before = source.nowNs();
      const wallBefore = source.now().getTime();
      await subject.pass(source, 20);
      assert.ok(source.nowNs() - before >= 20_000_000n);
      assert.ok(source.now().getTime() - wallBefore >= 20);
      assert.equal(Number.isNaN(source.now().getTime()), false);
    });

    it('fires timers no earlier than their delay, equal delays in scheduling order', async () => {
      const source = subject.create();
      const start = source.nowNs();
      const fired: [string, bigint][] = [];
      const record = (label: string) => (): void => {
        fired.push([label, source.nowNs() - start]);
      };
      source.schedule(30, record('late'));
      source.schedule(10, record('a'));
      source.schedule(10, record('b'));
      await subject.pass(source, 40);
      assert.deepEqual(
        fired.map(([label]) => label),
        ['a', 'b', 'late'],
      );
      // Node may fire up to 1 ms early by its own millisecond rounding; never more.
      assert.ok((fired[0]?.[1] ?? 0n) >= 9_000_000n);
      assert.ok((fired[2]?.[1] ?? 0n) >= 29_000_000n);
    });

    it('never fires a cancelled timer', async () => {
      const source = subject.create();
      let fired = false;
      source.schedule(10, () => (fired = true)).cancel();
      await subject.pass(source, 30);
      assert.equal(fired, false);
    });

    it('resolves sleep after the delay', async () => {
      const source = subject.create();
      let resolved = false;
      void source.sleep(10).then(() => (resolved = true));
      await subject.pass(source, 30);
      assert.equal(resolved, true);
    });
  });
}

describe('VirtualTimeScheduler fault injection and limits', () => {
  const create = (): VirtualTimeScheduler => new VirtualTimeScheduler({ wallEpochMs: Date.UTC(2026, 9, 5) });

  it('starts at the configured instants and moves only when advanced', async () => {
    const time = create();
    assert.equal(time.now().toISOString(), '2026-10-05T00:00:00.000Z');
    assert.equal(time.nowNs(), 0n);
    await time.advanceBy(1.5);
    assert.equal(time.nowNs(), 1_500_000n);
    assert.equal(time.now().toISOString(), '2026-10-05T00:00:00.001Z');
  });

  it('fires the next scheduled timer early once, never before the present', async () => {
    const time = create();
    const firedAt: bigint[] = [];
    time.fireEarlyBy(2_000_000n);
    time.schedule(10, () => firedAt.push(time.nowNs()));
    time.schedule(10, () => firedAt.push(time.nowNs()));
    time.fireEarlyBy(50_000_000n);
    time.schedule(10, () => firedAt.push(time.nowNs()));
    await time.advanceBy(20);
    assert.deepEqual(firedAt, [0n, 8_000_000n, 10_000_000n]);
    assert.throws(
      () => {
        time.fireEarlyBy(-1n);
      },
      { message: 'early firing -1 ns; expected a nonnegative offset' },
    );
  });

  it('skews the wall clock without moving monotonic time', () => {
    const time = create();
    time.skewWall(-250);
    assert.equal(time.now().toISOString(), '2026-10-04T23:59:59.750Z');
    assert.equal(time.nowNs(), 0n);
  });

  it('refuses invalid delays', () => {
    const time = create();
    for (const delay of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => time.schedule(delay, () => undefined), {
        message: `timer delay ${String(delay)} ms; expected a finite nonnegative number of milliseconds`,
      });
    }
  });

  it('refuses to advance by a negative or non-finite amount, so monotonic time never goes back', async () => {
    const time = create();
    await time.advanceBy(5);
    for (const ms of [-1, -0.000001, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      await assert.rejects(time.advanceBy(ms), {
        name: 'RangeError',
        message: `advance of ${String(ms)} ms; expected a finite nonnegative number of milliseconds`,
      });
    }
    assert.equal(time.nowNs(), 5_000_000n);
    await time.advanceBy(0);
    assert.equal(time.nowNs(), 5_000_000n);
  });

  it('lets promise continuations run between firings', async () => {
    const time = create();
    const steps: string[] = [];
    const flow = async (): Promise<void> => {
      await time.sleep(5);
      steps.push('slept');
      await Promise.resolve();
      steps.push('continued');
      time.schedule(1, () => steps.push('follow-up'));
    };
    void flow();
    await time.advanceBy(10);
    assert.deepEqual(steps, ['slept', 'continued', 'follow-up']);
    assert.equal(time.pendingTimerCount(), 0);
  });

  it('runs until idle, including timers scheduled while firing, and stops a runaway loop', async () => {
    const time = create();
    let count = 0;
    const chain = (): void => {
      count += 1;
      if (count < 3) {
        time.schedule(100, chain);
      }
    };
    time.schedule(100, chain);
    await time.advanceUntilIdle();
    assert.equal(count, 3);
    assert.equal(time.nowNs(), 300_000_000n);
    const forever = (): void => {
      time.schedule(0, forever);
    };
    time.schedule(0, forever);
    await assert.rejects(time.advanceUntilIdle(), {
      message: 'more than 100000 timer firings in one advance; expected the timers to go idle',
    });
  });
});
