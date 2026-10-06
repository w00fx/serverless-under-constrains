// The provider side of one simulated attempt (design §9.12): the accepted call, the commit
// transaction with its ledger item and treatment update, the response, and the three ways a
// commit meets a caller timeout — the CONTROL rejection with a late commit, the BR-RUA-025
// signal-observe-release path, and the safety release (OR-RUA-002 15 s).

import type { JsonObject, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { ATTEMPT_OFFSETS, nanos } from './attempt-run.ts';
import type { AttemptRun } from './attempt-run.ts';
import { instantAt } from './golden-values.ts';

/** A commit the provider confirmed, and the treatment item it wrote. */
export interface ConfirmedCommit {
  readonly commit_event_id: Uuid4;
  readonly confirmed_event_id: Uuid4;
  /** The COMMITTED_WAITING treatment item a targeted commit wrote; empty for an untargeted one. */
  readonly committed_treatment: JsonObject;
}

/**
 * Emits `provider_call_accepted` for the run's call and returns its event id.
 *
 * @example
 * const accepted = accept(run);
 */
export function accept(run: AttemptRun): Uuid4 {
  return run.provider.emit(
    'provider_call_accepted',
    run.at(ATTEMPT_OFFSETS.accepted),
    {
      provider_call_id: run.ids.provider_call_id,
      caller_id: run.env.context.caller,
      ...run.correlation,
      ...run.values,
    },
    [run.received_event_id],
  );
}

// One TransactWriteItems: the ledger item, the commit event and, when targeted, the treatment
// update ARMED -> COMMITTED_WAITING (design §9.3), then the confirmation after the acknowledgement.
/**
 * Accepts and commits the call, writing the ledger item and, when targeted, the COMMITTED_WAITING treatment.
 *
 * @example
 * const confirmed = commit(run, false, ATTEMPT_OFFSETS.committed);
 */
export function commit(run: AttemptRun, targeted: boolean, committedOffset: number): ConfirmedCommit {
  const accepted = accept(run);
  const committedMs = run.at(committedOffset);
  const requestedAt = instantAt(committedMs);
  const commitFields = {
    provider_commit_id: run.ids.provider_commit_id,
    provider_transaction_id: run.ids.provider_transaction_id,
    provider_call_id: run.ids.provider_call_id,
  };
  const commitEventId = run.provider.emit(
    'provider_transaction_committed',
    committedMs,
    { ...commitFields, ...run.correlation, ...run.values, targeted, commit_requested_at: requestedAt },
    [accepted],
  );
  run.env.timeline.addLedger(committedMs, {
    ...commitFields,
    ...run.correlation,
    ...run.values,
    status: 'SUCCEEDED',
    commit_requested_at: requestedAt,
  });
  const committedTreatment: JsonObject = targeted
    ? {
        state: 'COMMITTED_WAITING',
        version: 2,
        targeted_attempt_id: run.ids.attempt_id,
        provider_request_id: run.ids.provider_request_id,
        ...commitFields,
        commit_event_id: commitEventId,
      }
    : {};
  if (targeted) {
    run.env.timeline.addTreatment(committedMs, committedTreatment);
  }
  const ackOffset = committedOffset + (ATTEMPT_OFFSETS.commit_acknowledged - ATTEMPT_OFFSETS.committed);
  const confirmedEventId = run.provider.emit(
    'provider_commit_confirmed',
    run.at(committedOffset + (ATTEMPT_OFFSETS.commit_confirmed - ATTEMPT_OFFSETS.committed)),
    {
      provider_commit_id: run.ids.provider_commit_id,
      provider_transaction_id: run.ids.provider_transaction_id,
      provider_call_id: run.ids.provider_call_id,
      committed_at: instantAt(run.at(ackOffset)),
    },
    [commitEventId],
  );
  return {
    commit_event_id: commitEventId,
    confirmed_event_id: confirmedEventId,
    committed_treatment: committedTreatment,
  };
}

/**
 * Emits `provider_response_returned` and closes the provider call.
 *
 * @example
 * returnResponse(run, confirmed, run.at(ATTEMPT_OFFSETS.response_returned));
 */
export function returnResponse(run: AttemptRun, confirmed: ConfirmedCommit, returnedMs: number): void {
  run.provider.emit(
    'provider_response_returned',
    returnedMs,
    {
      provider_commit_id: run.ids.provider_commit_id,
      provider_transaction_id: run.ids.provider_transaction_id,
      provider_call_id: run.ids.provider_call_id,
      attempt_id: run.ids.attempt_id,
      provider_request_id: run.ids.provider_request_id,
    },
    [confirmed.confirmed_event_id],
  );
  run.env.timeline.addProviderCall(run.at(ATTEMPT_OFFSETS.received), returnedMs);
}

// AC-RUA-029 "uncontrolled timeout": a CONTROL commit slower than the deadline. The controller
// has no treatment item to signal and rejects the timeout as CONTROL_TRIAL (design §9.11).
/**
 * The CONTROL path after a caller timeout: the controller rejects it and the slow commit lands late.
 *
 * @example
 * lateUntargetedCommit(run, timeoutEventId);
 */
export function lateUntargetedCommit(run: AttemptRun, timeoutEventId: Uuid4): void {
  run.env.controller().emit(
    'caller_timeout_rejected',
    run.at(ATTEMPT_OFFSETS.signal_recorded),
    {
      reason: 'CONTROL_TRIAL',
      caller_timeout_event_id: timeoutEventId,
      attempt_id: run.ids.attempt_id,
      detail: `caller timeout ${timeoutEventId} belongs to a CONTROL trial; expected a COMMIT_THEN_TIMEOUT trial`,
    },
    [timeoutEventId],
  );
  const confirmed = commit(run, false, ATTEMPT_OFFSETS.late_commit);
  returnResponse(run, confirmed, run.at(ATTEMPT_OFFSETS.late_response_returned));
}

// BR-RUA-025: the controller signals the targeted commit, the provider observes the signal on
// its next 250 ms poll and releases the response immediately after.
/**
 * The BR-RUA-025 treatment path: signal, observation and release of the targeted commit.
 *
 * @example
 * signalAndRelease(run, confirmed, timeoutEventId);
 */
export function signalAndRelease(run: AttemptRun, confirmed: ConfirmedCommit, timeoutEventId: Uuid4): void {
  const signalMs = run.at(ATTEMPT_OFFSETS.signal_recorded);
  const signalEventId = run.env.controller().emit(
    'timeout_signal_recorded',
    signalMs,
    {
      provider_commit_id: run.ids.provider_commit_id,
      attempt_id: run.ids.attempt_id,
      caller_timeout_event_id: timeoutEventId,
      provider_commit_event_id: confirmed.commit_event_id,
    },
    [confirmed.commit_event_id, timeoutEventId],
  );
  const signalled: JsonObject = {
    ...confirmed.committed_treatment,
    state: 'TIMEOUT_SIGNALLED',
    version: 3,
    signal_event_id: signalEventId,
    signal_caller_event_id: timeoutEventId,
  };
  run.env.timeline.addTreatment(signalMs, signalled);
  const refs = {
    provider_commit_id: run.ids.provider_commit_id,
    provider_call_id: run.ids.provider_call_id,
    attempt_id: run.ids.attempt_id,
  };
  const observedMs = run.at(ATTEMPT_OFFSETS.timeout_observed);
  const observedEventId = run.provider.emit(
    'treatment_timeout_observed',
    observedMs,
    { ...refs, signal_event_id: signalEventId },
    [signalEventId],
  );
  const observed: JsonObject = {
    ...signalled,
    state: 'TIMEOUT_OBSERVED',
    version: 4,
    observed_event_id: observedEventId,
  };
  run.env.timeline.addTreatment(observedMs, observed);
  const releasedMs = run.at(ATTEMPT_OFFSETS.response_released);
  const releaseEventId = run.provider.emit('treatment_response_released', releasedMs, refs, [observedEventId]);
  run.env.timeline.addTreatment(releasedMs, {
    ...observed,
    state: 'RESPONSE_RELEASED',
    version: 5,
    release_event_id: releaseEventId,
  });
  run.env.timeline.addProviderCall(run.at(ATTEMPT_OFFSETS.received), releasedMs);
}

// The controller never signals in time, so the provider's 15 s safety deadline releases the
// barrier (OR-RUA-002); the late timeout then meets a SAFETY_RELEASED item (design §9.11).
/**
 * The unsignalled targeted commit, released by the provider's safety deadline.
 *
 * @example
 * safetyRelease(run, confirmed, timeoutEventId);
 */
export function safetyRelease(run: AttemptRun, confirmed: ConfirmedCommit, timeoutEventId: Uuid4): void {
  const releasedMs = run.at(ATTEMPT_OFFSETS.commit_acknowledged + ATTEMPT_OFFSETS.safety_release_after_ack);
  run.provider.emit(
    'treatment_safety_released',
    releasedMs,
    {
      cause: 'SAFETY_DEADLINE',
      from_state: 'COMMITTED_WAITING',
      provider_commit_id: run.ids.provider_commit_id,
      provider_call_id: run.ids.provider_call_id,
      attempt_id: run.ids.attempt_id,
      elapsed_since_commit_ns: nanos(ATTEMPT_OFFSETS.safety_release_after_ack),
    },
    [confirmed.commit_event_id],
  );
  run.env.timeline.addTreatment(releasedMs, {
    ...confirmed.committed_treatment,
    state: 'SAFETY_RELEASED',
    version: 3,
    safety_release_cause: 'SAFETY_DEADLINE',
  });
  run.env.timeline.addProviderCall(run.at(ATTEMPT_OFFSETS.received), releasedMs);
  run.env
    .controller()
    .emit(
      'late_timeout_signal_rejected',
      run.at(ATTEMPT_OFFSETS.late_signal_rejected),
      { caller_timeout_event_id: timeoutEventId, attempt_id: run.ids.attempt_id, treatment_state: 'SAFETY_RELEASED' },
      [timeoutEventId],
    );
}
