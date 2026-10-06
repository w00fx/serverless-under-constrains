// The shared provider-client contract of BR-RUA-028: "The complete dispatch, timeout, abort,
// and provider-call behavior belongs to one shared provider-client contract. Variants may invoke
// it but may not reimplement or override it." Variants and the probe caller call
// `performAttempt`; every timing value is a code constant (`transport-options.ts`).
//
// One attempt (design §5.3 C1-C6):
// C1  register `PRE_DISPATCH` with `attempt_registered` in one transaction; anything but an
//     applied registration leaves no attempt to report on, so the call throws;
// C2  build the call locally; a failure is proven pre-dispatch by the conditional
//     `PRE_DISPATCH -> NOT_DISPATCHED` transition with `attempt_not_dispatched` (AC-RUA-015);
// C3  `dispatch_started` with `PRE_DISPATCH -> DISPATCHED` must apply before any transport
//     call; otherwise the transport is never invoked (AC-RUA-028);
// C4/C5 race the transport against the 3 s deadline (`transport-race.ts`): a timer win aborts
//     and appends `caller_timeout_recorded`, and only that durable append makes the attempt
//     `TIMED_OUT` (BR-RUA-023, AC-RUA-044); a late settlement is recorded, never parsed (D-26),
//     and only when it arrives within the bounded grace, so a transport that never settles
//     cannot hold back the outcome (RK-04);
// C6  append `attempt_outcome_recorded`. Request state belongs to the variant.

import type { EventBody, JournalEvent } from '../event-journal/journal-event.ts';
import type { JournalScope } from '../event-journal/journal-scope.ts';
import type { JournalWriter } from '../event-journal/journal-writer.ts';
import type { MonotonicClock, Uuid4, UuidSource, WallClock } from '../record-contract/primitives.ts';
import type { AttemptCorrelation } from '../record-contract/records/group-b/shared-shapes.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { AttemptInput } from './attempt-input.ts';
import { assertValidAttemptInput } from './attempt-input.ts';
import type { AttemptReport, AttemptResolution } from './attempt-resolution.ts';
import { outcomeRecordBody, resolutionFromResponse, toAttemptReport } from './attempt-resolution.ts';
import type { AttemptStatePort } from './attempt-state-port.ts';
import type { DeadlineTimer } from './deadline-timer.ts';
import { runDurableTransition } from './durable-transition.ts';
import type { TransitionResult } from './durable-transition.ts';
import { buildProviderCall } from './provider-call.ts';
import type { CallBuildFailure } from './provider-call.ts';
import type { ProviderInvocationPort } from './provider-invocation-port.ts';
import { parseProviderResponse } from './provider-response.ts';
import { lateSettlementWithin, raceTransportAgainstDeadline } from './transport-race.ts';
import type { LateSettlement, RaceDecision } from './transport-race.ts';
import { PROVIDER_CLIENT_TIMING } from './transport-options.ts';

const NS_PER_MS = 1_000_000n;

export interface ProviderClientDeps {
  readonly invoker: ProviderInvocationPort;
  readonly attempts: AttemptStatePort;
  /** The caller journal writer of this source instance. */
  readonly journal: JournalWriter;
  /**
   * The scope the journal writer was built with; the call carries its execution identity. The
   * writer keeps its scope private, so the composer must pass the same value (one source of
   * truth would need a WP-05 API addition).
   */
  readonly scope: JournalScope;
  readonly monotonic: MonotonicClock;
  readonly wall: WallClock;
  readonly timer: DeadlineTimer;
  readonly ids: UuidSource;
}

/** Why the pre-dispatch registration of C1 did not apply. */
export type RegistrationFailure = Exclude<TransitionResult['kind'], 'applied'>;

/**
 * Thrown by `performAttempt` when C1 did not apply. `ambiguous` leaves the attempt state
 * unknowable (its dispatch is `UNKNOWN`); `rejected` and `condition_failed` leave no attempt.
 */
export class AttemptNotRegisteredError extends Error {
  readonly attempt_id: Uuid4;
  readonly registration: RegistrationFailure;

  constructor(attemptId: Uuid4, registration: RegistrationFailure) {
    super(`attempt ${attemptId} registration ${registration}; expected the PRE_DISPATCH registration to apply`);
    this.name = 'AttemptNotRegisteredError';
    this.attempt_id = attemptId;
    this.registration = registration;
  }
}

interface ResolvedAttempt {
  readonly resolution: AttemptResolution;
  /** The last durable event of the attempt, the cause of its outcome event. */
  readonly cause: JournalEvent;
}

/**
 * Performs provider attempts under the BR-RUA-028 contract. One attempt at a time: the journal
 * writer serializes its appends, so a second `performAttempt` on the same client before the
 * first one settled throws from `JournalWriter.prepare` ("expected an idle writer").
 *
 * @example
 * const client = new ProviderClient({ invoker, attempts, journal, scope, monotonic, wall, timer, ids });
 * const report = await client.performAttempt({ caller_id: 'conventional', refund_request_id: 'ref-poc-001',
 *   payment_id: 'pay-poc-001', amount_minor: 10000, currency: 'BRL', provider_qualifier: '7', causation_event_ids: [] });
 */
export class ProviderClient {
  readonly #deps: ProviderClientDeps;

  constructor(deps: ProviderClientDeps) {
    this.#deps = deps;
  }

  /**
   * Performs one physical attempt and records its outcome. Throws a RangeError for an input the
   * attempt records could not hold, and an `AttemptNotRegisteredError` when C1 did not apply.
   *
   * @example
   * const report = await client.performAttempt(input);
   * if (report.outcome === 'TIMED_OUT') propagateFailure(); // knowledge is UNKNOWN (BR-RUA-004)
   */
  async performAttempt(input: AttemptInput): Promise<AttemptReport> {
    assertValidAttemptInput(input);
    const { ids, journal } = this.#deps;
    const correlation: AttemptCorrelation = {
      attempt_id: ids.next(),
      provider_request_id: ids.next(),
      refund_request_id: input.refund_request_id,
    };
    const registered = await this.#register(input, correlation);
    const resolved = await this.#resolve(input, correlation, registered);
    const outcome = await journal.append(
      'attempt_outcome_recorded',
      outcomeRecordBody(correlation, resolved.resolution),
      [resolved.cause.event_id],
    );
    const attemptIds = { attempt_id: correlation.attempt_id, provider_request_id: correlation.provider_request_id };
    return toAttemptReport(
      attemptIds,
      resolved.resolution,
      outcome.kind === 'appended' ? outcome.event.event_id : undefined,
    );
  }

  async #register(input: AttemptInput, correlation: AttemptCorrelation): Promise<JournalEvent> {
    const body: EventBody<'attempt_registered'> = {
      ...correlation,
      payment_id: input.payment_id,
      amount_minor: input.amount_minor,
      currency: input.currency,
      provider_qualifier: input.provider_qualifier,
    };
    const result = await runDurableTransition(
      this.#deps.journal,
      'attempt_registered',
      body,
      input.causation_event_ids,
      (put) => this.#deps.attempts.registerPreDispatch(correlation, put),
    );
    if (result.kind !== 'applied') {
      throw new AttemptNotRegisteredError(correlation.attempt_id, result.kind);
    }
    return result.event;
  }

  async #resolve(
    input: AttemptInput,
    correlation: AttemptCorrelation,
    registered: JournalEvent,
  ): Promise<ResolvedAttempt> {
    const ids = { attempt_id: correlation.attempt_id, provider_request_id: correlation.provider_request_id };
    const call = buildProviderCall(input, ids, this.#deps.scope);
    if (!call.ok) {
      return this.#recordNotDispatched(correlation, registered, call.error);
    }
    const dispatchAt = this.#deps.wall.now();
    const dispatchBody: EventBody<'dispatch_started'> = {
      ...correlation,
      dispatch_at: formatUtcMillis(dispatchAt),
      deadline_at: formatUtcMillis(
        new Date(dispatchAt.getTime() + Number(PROVIDER_CLIENT_TIMING.deadline_ns / NS_PER_MS)),
      ),
      deadline_ns: PROVIDER_CLIENT_TIMING.deadline_ns.toString() as EventBody<'dispatch_started'>['deadline_ns'],
    };
    const dispatched = await runDurableTransition(
      this.#deps.journal,
      'dispatch_started',
      dispatchBody,
      [registered.event_id],
      (put) => this.#deps.attempts.transitionToDispatched(correlation.attempt_id, put),
    );
    if (dispatched.kind === 'rejected') {
      return this.#recordNotDispatched(correlation, registered, {
        code: 'DISPATCH_TRANSITION_REJECTED',
        subject: 'BR-RUA-021',
        detail: `the dispatch_started transition of attempt ${correlation.attempt_id} was definitively rejected by the store; expected it to apply before any transport call`,
      });
    }
    if (dispatched.kind !== 'applied') {
      return undispatchedUnknown(registered, dispatched.kind);
    }
    const decision = await raceTransportAgainstDeadline(this.#deps, call.value, PROVIDER_CLIENT_TIMING.deadline_ns);
    if (decision.winner === 'TRANSPORT') {
      const parsed = parseProviderResponse(decision.result, { ...ids, qualifier: input.provider_qualifier });
      return { resolution: resolutionFromResponse(parsed, decision.settled_after_ns), cause: dispatched.event };
    }
    return this.#recordTimeout(correlation, dispatched.event, dispatchBody, decision);
  }

  // The attempt never reached transport. Only the applied conditional transition proves it;
  // without it the dispatch state cannot be located and stays UNKNOWN (BR-RUA-021).
  async #recordNotDispatched(
    correlation: AttemptCorrelation,
    registered: JournalEvent,
    failure: CallBuildFailure | (Omit<CallBuildFailure, 'code'> & { readonly code: 'DISPATCH_TRANSITION_REJECTED' }),
  ): Promise<ResolvedAttempt> {
    const result = await runDurableTransition(
      this.#deps.journal,
      'attempt_not_dispatched',
      { ...correlation, failure },
      [registered.event_id],
      (put) => this.#deps.attempts.transitionToNotDispatched(correlation.attempt_id, put),
    );
    if (result.kind === 'applied') {
      return { resolution: { outcome: 'FAILED', dispatch_state: 'NOT_DISPATCHED', failure }, cause: result.event };
    }
    return { resolution: { outcome: 'FAILED', dispatch_state: 'UNKNOWN', failure }, cause: registered };
  }

  async #recordTimeout(
    correlation: AttemptCorrelation,
    dispatchStarted: JournalEvent,
    dispatchBody: EventBody<'dispatch_started'>,
    decision: Extract<RaceDecision, { readonly winner: 'TIMER' }>,
  ): Promise<ResolvedAttempt> {
    const { journal, wall } = this.#deps;
    const timeout = await journal.append(
      'caller_timeout_recorded',
      {
        ...correlation,
        elapsed_ns: decision.elapsed_ns,
        monotonic_origin_event_id: dispatchStarted.event_id,
        dispatch_at: dispatchBody.dispatch_at,
        deadline_at: dispatchBody.deadline_at,
        timer_fired_at: decision.timer_fired_at,
        abort_requested_at: decision.abort_requested_at,
        recorded_at: formatUtcMillis(wall.now()),
        arbiter_winner: 'TIMER',
        transport_settled_at_claim: false,
      },
      [dispatchStarted.event_id],
    );
    const timing = { dispatch_to_settlement_ns: decision.elapsed_ns };
    if (timeout.kind === 'appended') {
      await this.#recordLateSettlement(correlation, dispatchStarted, decision.late_settlement);
      return { resolution: { ...timing, outcome: 'TIMED_OUT', dispatch_state: 'DISPATCHED' }, cause: timeout.event };
    }
    const failure = {
      code: 'TIMEOUT_RECORD_NOT_DURABLE',
      subject: 'BR-RUA-023',
      detail: `caller_timeout_recorded of attempt ${correlation.attempt_id} was not durably appended (${timeout.reason}); expected an appended timeout record before TIMED_OUT`,
    } as const;
    return {
      resolution: { ...timing, outcome: 'FAILED', dispatch_state: 'DISPATCHED', failure },
      cause: dispatchStarted,
    };
  }

  // D-26: the settlement after a timer win is recorded by kind only, if it arrives within the
  // grace. A stopped journal (failed timeout append) could record nothing, so it is not awaited.
  async #recordLateSettlement(
    correlation: AttemptCorrelation,
    dispatchStarted: JournalEvent,
    lateSettlement: Promise<LateSettlement>,
  ): Promise<void> {
    const late = await lateSettlementWithin(
      this.#deps,
      lateSettlement,
      PROVIDER_CLIENT_TIMING.late_settlement_grace_ns,
    );
    if (late !== undefined) {
      await this.#deps.journal.append('transport_settled_after_timeout', { ...correlation, ...late }, [
        dispatchStarted.event_id,
      ]);
    }
  }
}

// C3 did not apply and was not definitively rejected: the transport is never invoked, and
// whether the boundary moved cannot be located, so dispatch is UNKNOWN (AC-RUA-028).
function undispatchedUnknown(registered: JournalEvent, kind: 'condition_failed' | 'ambiguous'): ResolvedAttempt {
  const code = kind === 'ambiguous' ? 'DISPATCH_TRANSITION_AMBIGUOUS' : 'DISPATCH_TRANSITION_CONDITION_FAILED';
  return {
    resolution: {
      outcome: 'FAILED',
      dispatch_state: 'UNKNOWN',
      failure: {
        code,
        subject: 'BR-RUA-021',
        detail: `the dispatch_started transition ended ${kind}; expected applied before any transport call, so the transport was not invoked`,
      },
    },
    cause: registered,
  };
}
