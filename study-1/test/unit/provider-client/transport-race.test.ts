// raceTransportAgainstDeadline (design §5.3 C4-C5, BR-RUA-023, D-26) and the transport-port
// helpers: the timer is armed before the invoke in the same tick, a timer win aborts before
// reporting, a transport win cancels the timer, and a late settlement reports only its kind and
// elapsed time.

import assert from 'node:assert/strict';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { describe, it } from 'node:test';

import { DeadlineTimer } from '../../../src/provider-client/deadline-timer.ts';
import { transportErrorFromThrown } from '../../../src/provider-client/provider-invocation-port.ts';
import { lateSettlementKind, raceTransportAgainstDeadline } from '../../../src/provider-client/transport-race.ts';
import type { RaceDecision } from '../../../src/provider-client/transport-race.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { EPOCH_MS } from '../../support/event-journal/journal-fixtures.ts';
import {
  invokeResponse,
  MS,
  PROVIDER_CALL as CALL,
  succeededResponder,
  transportError,
} from '../../support/provider-client/provider-client-fixtures.ts';
import { ScriptedProviderInvoker } from '../../support/provider-client/scripted-provider-invoker.ts';

const DEADLINE_NS = 3_000n * MS;

function setup(): {
  readonly time: VirtualTimeScheduler;
  readonly invoker: ScriptedProviderInvoker;
  race: () => Promise<RaceDecision>;
} {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS, monotonicOriginNs: 7n });
  const invoker = new ScriptedProviderInvoker(time);
  const deps = { invoker, timer: new DeadlineTimer({ monotonic: time, scheduler: time }), monotonic: time, wall: time };
  return { time, invoker, race: () => raceTransportAgainstDeadline(deps, CALL, DEADLINE_NS) };
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
});
