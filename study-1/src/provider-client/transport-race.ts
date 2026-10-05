// Steps C4 and C5 of design §5.3 (BR-RUA-023): after the durable dispatch transition, capture
// the source-local monotonic origin, start the deadline timer and invoke the transport in the
// same tick. One arbiter lets exactly one of them win:
// - the timer wins only after at least the deadline of monotonic time while the transport is
//   still unsettled; it requests the abort at once, before anything is written, so the provider
//   stays behind its barrier until the controller sees the durable timeout write;
// - the transport wins when it settles first; the timer is cancelled.
// A transport that settles after the timer won is reported as a late settlement: its kind and
// elapsed time only, never its payload (D-26, BR-RUA-015).

import { elapsedNs } from '../record-contract/decimal.ts';
import type { DecimalString, MonotonicClock, UtcMillis, WallClock } from '../record-contract/primitives.ts';
import type { ProviderRefundCall } from '../record-contract/records/group-a/provider_refund_call.ts';
import type { TransportSettlementKind } from '../record-contract/records/group-b/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { DeadlineTimer } from './deadline-timer.ts';
import type { ProviderInvocationPort, ProviderTransportResult } from './provider-invocation-port.ts';
import { ABORT_ERROR_NAME, transportErrorFromThrown } from './provider-invocation-port.ts';
import { SettlementArbiter } from './settlement-arbiter.ts';

export interface TransportRaceDeps {
  readonly invoker: ProviderInvocationPort;
  readonly timer: DeadlineTimer;
  readonly monotonic: MonotonicClock;
  readonly wall: WallClock;
}

/** A transport settlement observed after the timer won (`transport_settled_after_timeout`). */
export interface LateSettlement {
  readonly settlement_kind: TransportSettlementKind;
  readonly observed_after_elapsed_ns: DecimalString;
}

export type RaceDecision =
  | {
      readonly winner: 'TRANSPORT';
      readonly result: ProviderTransportResult;
      /** Monotonic nanoseconds from the origin to the settlement. */
      readonly settled_after_ns: DecimalString;
    }
  | {
      readonly winner: 'TIMER';
      /** Monotonic nanoseconds from the origin to the winning firing, at least the deadline. */
      readonly elapsed_ns: DecimalString;
      readonly timer_fired_at: UtcMillis;
      readonly abort_requested_at: UtcMillis;
      /** Resolves when the aborted transport settles; never rejects. */
      readonly late_settlement: Promise<LateSettlement>;
    };

interface TimedSettlement {
  readonly result: ProviderTransportResult;
  readonly at_ns: bigint;
}

/**
 * Races one provider invocation against the deadline and returns the arbiter's decision.
 *
 * @example
 * const decision = await raceTransportAgainstDeadline(deps, call, 3_000_000_000n);
 * if (decision.winner === 'TIMER') await recordTimeout(decision);
 */
export function raceTransportAgainstDeadline(
  deps: TransportRaceDeps,
  call: ProviderRefundCall,
  deadlineNs: bigint,
): Promise<RaceDecision> {
  const { invoker, timer, monotonic, wall } = deps;
  const arbiter = new SettlementArbiter();
  const controller = new AbortController();
  return new Promise((resolve) => {
    const claim = (winner: RaceDecision['winner'], decide: () => RaceDecision): void => {
      if (arbiter.claim(winner)) {
        resolve(decide());
      }
    };
    const originNs = monotonic.nowNs();
    const timerHandle = timer.start(originNs, deadlineNs, (elapsed) => {
      claim('TIMER', () => {
        const timerFiredAt = formatUtcMillis(wall.now());
        controller.abort();
        return {
          winner: 'TIMER',
          elapsed_ns: elapsed.toString() as DecimalString,
          timer_fired_at: timerFiredAt,
          abort_requested_at: formatUtcMillis(wall.now()),
          late_settlement: settlement.then((late) => lateSettlementOf(late, originNs)),
        };
      });
    });
    const settlement = settleTransport(invoker, call, controller.signal, monotonic);
    void settlement.then((settled) => {
      claim('TRANSPORT', () => {
        timerHandle.cancel();
        return { winner: 'TRANSPORT', result: settled.result, settled_after_ns: elapsedNs(originNs, settled.at_ns) };
      });
    });
  });
}

// Invokes the port and turns a throw or a rejection into a transport error: the dispatch
// boundary is already crossed, so nothing the transport throws can prove non-dispatch.
function settleTransport(
  invoker: ProviderInvocationPort,
  call: ProviderRefundCall,
  signal: AbortSignal,
  monotonic: MonotonicClock,
): Promise<TimedSettlement> {
  let pending: Promise<ProviderTransportResult>;
  try {
    pending = invoker.invoke(call, signal);
  } catch (thrown) {
    pending = Promise.resolve(transportErrorFromThrown(thrown));
  }
  return pending.catch(transportErrorFromThrown).then((result) => ({ result, at_ns: monotonic.nowNs() }));
}

/**
 * The kind of a settlement that arrived after the timer won (D-26).
 *
 * @example
 * lateSettlementKind({ kind: 'transport_error', error_name: 'AbortError', message: 'Request aborted' }); // 'aborted'
 */
export function lateSettlementKind(result: ProviderTransportResult): TransportSettlementKind {
  if (result.kind === 'response') {
    return 'resolved';
  }
  return result.error_name === ABORT_ERROR_NAME ? 'aborted' : 'rejected';
}

function lateSettlementOf(settled: TimedSettlement, originNs: bigint): LateSettlement {
  return {
    settlement_kind: lateSettlementKind(settled.result),
    observed_after_elapsed_ns: elapsedNs(originNs, settled.at_ns),
  };
}
