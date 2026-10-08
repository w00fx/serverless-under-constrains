// raceTransportAgainstDeadline (design §5.3 C4-C5, BR-RUA-023, D-26) and the transport-port
// helpers: the timer is armed before the invoke in the same tick, a timer win aborts before
// reporting, a transport win cancels the timer, and a late settlement reports only its kind and
// elapsed time.

import assert from 'node:assert/strict';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { describe, it } from 'node:test';

import { DeadlineTimer } from '../../../src/provider-client/deadline-timer.ts';
import {
  MALFORMED_PORT_RESULT_NAME,
  transportErrorFromThrown,
  UNREPRESENTABLE_THROWN_NAME,
} from '../../../src/provider-client/provider-invocation-port.ts';
import {
  lateSettlementKind,
  lateSettlementWithin,
  raceTransportAgainstDeadline,
} from '../../../src/provider-client/transport-race.ts';
import type { LateSettlement, RaceDecision } from '../../../src/provider-client/transport-race.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { EPOCH_MS } from '../../support/event-journal/journal-fixtures.ts';
import {
  invokeResponse,
  MS,
  PROVIDER_CALL as CALL,
  succeededResponder,
  transportError,
} from '../../support/provider-client/provider-client-fixtures.ts';
import { hostileThrownValues } from '../../support/provider-client/hostile-thrown-values.ts';
import { ScriptedProviderInvoker } from '../../support/provider-client/scripted-provider-invoker.ts';

const DEADLINE_NS = 3_000n * MS;

const UNREPRESENTABLE = transportError(
  UNREPRESENTABLE_THROWN_NAME,
  'the thrown value has no readable name or string form',
);

function setup(): {
  readonly time: VirtualTimeScheduler;
  readonly invoker: ScriptedProviderInvoker;
  readonly timer: DeadlineTimer;
  race: () => Promise<RaceDecision>;
} {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS, monotonicOriginNs: 7n });
  const invoker = new ScriptedProviderInvoker(time);
  const timer = new DeadlineTimer({ monotonic: time, scheduler: time });
  const deps = { invoker, timer, monotonic: time, wall: time };
  return { time, invoker, timer, race: () => raceTransportAgainstDeadline(deps, CALL, DEADLINE_NS) };
}

describe('raceTransportAgainstDeadline', () => {
  it('a transport settling first wins, cancels the timer and reports its elapsed time', async () => {
    const { time, invoker, race } = setup();
    invoker.resolveAfter(1_500n * MS, succeededResponder);
    const pending = race();
    // The timer was armed and the transport invoked synchronously, in the same tick.
    assert.equal(invoker.invocations().length, 1);
    assert.equal(time.pendingTimerCount(), 2);
    await time.advanceUntilIdle();
    const decision = await pending;
    assert.equal(decision.winner, 'TRANSPORT');
    assert.equal(decision.settled_after_ns, '1500000000');
    assert.deepEqual(decision.result, succeededResponder(CALL));
    assert.equal(time.pendingTimerCount(), 0);
    assert.equal(invoker.invocations()[0]?.signal.aborted, false);
  });

  it('a timer win aborts the transport before reporting, then reports the late settlement', async () => {
    const { time, invoker, race } = setup();
    invoker.hang();
    const pending = race();
    await time.advanceBy(3_000);
    const decision = await pending;
    assert.equal(invoker.invocations()[0]?.signal.aborted, true);
    assert.ok(decision.winner === 'TIMER');
    assert.equal(decision.elapsed_ns, '3000000000');
    assert.equal(decision.timer_fired_at, '2026-10-05T12:00:03.000Z');
    assert.equal(decision.abort_requested_at, '2026-10-05T12:00:03.000Z');
    assert.deepEqual(await decision.late_settlement, {
      settlement_kind: 'aborted',
      observed_after_elapsed_ns: '3000000000',
    });
  });

  it('a late response is reported as resolved at its own elapsed time', async () => {
    const { time, invoker, race } = setup();
    invoker.resolveAfterAbort(250n * MS, succeededResponder);
    const pending = race();
    await time.advanceBy(3_000);
    const decision = await pending;
    assert.ok(decision.winner === 'TIMER');
    await time.advanceUntilIdle();
    assert.deepEqual(await decision.late_settlement, {
      settlement_kind: 'resolved',
      observed_after_elapsed_ns: '3250000000',
    });
  });

  it('a transport that throws synchronously still lets the race settle as a transport win', async () => {
    const { time, invoker, race } = setup();
    invoker.throwBeforeSend(new TypeError('bad payload'));
    const pending = race();
    await nextMacrotask();
    const decision = await pending;
    assert.ok(decision.winner === 'TRANSPORT');
    assert.deepEqual(decision.result, transportError('TypeError', 'bad payload'));
    assert.equal(decision.settled_after_ns, '0');
    assert.equal(time.pendingTimerCount(), 0);
  });

  // Regression (WP-06 review round 1): String(Object.create(null)) threw inside the rejection
  // mapper, so the transport never claimed, the timer won at 3 s although the transport had
  // settled at 100 ms, and an unhandled rejection escaped.
  it('a rejection with a non-stringifiable value is a transport win at its own time', async () => {
    for (const thrown of hostileThrownValues()) {
      const { time, invoker, race } = setup();
      invoker.rejectAfter(100n * MS, thrown);
      const pending = race();
      await time.advanceBy(100);
      const decision = await pending;
      assert.ok(decision.winner === 'TRANSPORT');
      assert.deepEqual(decision.result, UNREPRESENTABLE);
      assert.equal(decision.settled_after_ns, '100000000');
      assert.equal(time.pendingTimerCount(), 0);
    }
  });

  it('a port that returns a bare settlement instead of a promise still settles the race', async () => {
    const { time, invoker, race } = setup();
    invoker.returnWithoutPromise(succeededResponder);
    const decision = await race();
    assert.ok(decision.winner === 'TRANSPORT');
    assert.deepEqual(decision.result, succeededResponder(CALL));
    assert.equal(decision.settled_after_ns, '0');
    assert.equal(time.pendingTimerCount(), 0);
  });

  // Regression (WP-06 review round 2): a resolved value that is not a settlement reached the
  // classification as is, and reading its `kind` threw after the dispatch boundary.
  it('a port that resolves a malformed value is a transport win as MalformedPortResult', async () => {
    const { time, invoker, race } = setup();
    invoker.resolveMalformedAfter(100n * MS, undefined);
    const pending = race();
    await time.advanceBy(100);
    const decision = await pending;
    assert.ok(decision.winner === 'TRANSPORT');
    assert.equal(
      decision.result.kind === 'transport_error' ? decision.result.error_name : '',
      MALFORMED_PORT_RESULT_NAME,
    );
    assert.equal(decision.settled_after_ns, '100000000');
    assert.equal(time.pendingTimerCount(), 0);
  });
});

describe('lateSettlementWithin', () => {
  const LATE: LateSettlement = {
    settlement_kind: 'aborted',
    observed_after_elapsed_ns: '3000000000' as LateSettlement['observed_after_elapsed_ns'],
  };

  it('returns a settlement that arrives within the grace and cancels the grace timer', async () => {
    const { time, timer } = setup();
    const late = new Promise<LateSettlement>((resolve) => {
      time.schedule(1_999, () => {
        resolve(LATE);
      });
    });
    let seen: LateSettlement | undefined | 'pending' = 'pending';
    void lateSettlementWithin({ timer, monotonic: time }, late, 2_000n * MS).then((result) => {
      seen = result;
    });
    await time.advanceBy(1_999);
    await nextMacrotask();
    assert.deepEqual(seen, LATE);
    assert.equal(time.pendingTimerCount(), 0);
  });

  it('returns undefined once the grace has elapsed, and not a millisecond earlier', async () => {
    const { time, timer } = setup();
    let seen: LateSettlement | undefined | 'pending' = 'pending';
    void lateSettlementWithin(
      { timer, monotonic: time },
      new Promise<LateSettlement>(() => undefined),
      2_000n * MS,
    ).then((result) => {
      seen = result;
    });
    await time.advanceBy(1_999);
    await nextMacrotask();
    assert.equal(seen, 'pending');
    await time.advanceBy(1);
    await nextMacrotask();
    assert.equal(seen, undefined);
    assert.equal(time.pendingTimerCount(), 0);
  });

  it('ignores a settlement that arrives after the grace', async () => {
    const { time, timer } = setup();
    let release: (value: LateSettlement) => void = () => undefined;
    const late = new Promise<LateSettlement>((resolve) => {
      release = resolve;
    });
    const result = lateSettlementWithin({ timer, monotonic: time }, late, 5n * MS);
    await time.advanceBy(5);
    release(LATE);
    assert.equal(await result, undefined);
  });
});

describe('lateSettlementKind', () => {
  it('maps a response to resolved, an AbortError to aborted and any other error to rejected', () => {
    assert.equal(lateSettlementKind(invokeResponse(new Uint8Array())), 'resolved');
    assert.equal(lateSettlementKind(transportError('AbortError', 'Request aborted')), 'aborted');
    assert.equal(lateSettlementKind(transportError('TimeoutError', 'socket')), 'rejected');
  });
});

describe('transportErrorFromThrown', () => {
  it('keeps the name and message of an Error and names anything else NonErrorThrown', () => {
    assert.deepEqual(
      transportErrorFromThrown(new RangeError('out of range')),
      transportError('RangeError', 'out of range'),
    );
    assert.deepEqual(transportErrorFromThrown('boom'), transportError('NonErrorThrown', 'boom'));
    assert.deepEqual(transportErrorFromThrown(undefined), transportError('NonErrorThrown', 'undefined'));
  });

  it('names a value whose name, message or string form throws UnrepresentableThrown', () => {
    for (const thrown of hostileThrownValues()) {
      assert.deepEqual(transportErrorFromThrown(thrown), UNREPRESENTABLE);
    }
  });

  it('converts a non-string name or message of an Error to text', () => {
    const odd = Object.assign(new Error('m'), { name: 42 as unknown as string });
    assert.deepEqual(transportErrorFromThrown(odd), transportError('42', 'm'));
  });
});
