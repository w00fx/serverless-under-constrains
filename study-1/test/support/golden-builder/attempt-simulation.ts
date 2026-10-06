// One provider attempt across the caller, the provider and the treatment controller, emitted with
// the causation chains of the production writers (provider-client, refund-provider,
// treatment-controller) and timed by the expected sequences of design §9.12. Offsets are from the
// dispatch instant D: the provider receives the call 60 ms later, an untargeted commit returns
// within 130 ms, and the caller's 3 s timer (OR-RUA-002) fires at D + 3000.

import type { OutcomeClass } from '../../../src/attempt-lifecycle/outcome-classification.ts';
import type { JsonObject, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { ATTEMPT_OFFSETS, nanos } from './attempt-run.ts';
import type { AttemptEnvironment, AttemptIds, AttemptResult, AttemptRun, AttemptSetup } from './attempt-run.ts';
import { FINANCIAL_FIXTURE, GOLDEN_PROVIDER_VERSION, goldenUuid, instantAt, labelDigest } from './golden-values.ts';
import {
  accept,
  commit,
  lateUntargetedCommit,
  returnResponse,
  safetyRelease,
  signalAndRelease,
} from './provider-commit-simulation.ts';

/**
 * Emits one attempt end to end and records its ledger, provider-activity and treatment facts.
 *
 * @example
 * const result = simulateAttempt(env, { plan: { behavior: 'succeeded' }, number: 1, caller, invocation_event_id, dispatch_ms });
 */
export function simulateAttempt(env: AttemptEnvironment, setup: AttemptSetup): AttemptResult {
  const run = startAttempt(env, setup);
  switch (setup.plan.behavior) {
    case 'succeeded':
      return succeeded(run);
    case 'rejected':
      return rejected(run);
    case 'commit_failed':
      return commitFailed(run);
    case 'targeted_timeout':
    case 'safety_release':
    case 'untargeted_timeout':
      return timedOut(run);
  }
}

function startAttempt(env: AttemptEnvironment, setup: AttemptSetup): AttemptRun {
  const prefix = `${env.context.label}/attempt-${String(setup.number)}`;
  const ids: AttemptIds = {
    attempt_id: goldenUuid(`${prefix}/attempt_id`),
    provider_request_id: goldenUuid(`${prefix}/provider_request_id`),
    provider_call_id: goldenUuid(`${prefix}/provider_call_id`),
    provider_commit_id: goldenUuid(`${prefix}/provider_commit_id`),
    provider_transaction_id: goldenUuid(`${prefix}/provider_transaction_id`),
  };
  const plan = setup.plan;
  const correlation: JsonObject = {
    attempt_id: ids.attempt_id,
    provider_request_id: ids.provider_request_id,
    refund_request_id: plan.refund_request_id ?? FINANCIAL_FIXTURE.refund_request_id,
  };
  const values = {
    payment_id: plan.payment_id ?? FINANCIAL_FIXTURE.payment_id,
    amount_minor: plan.amount_minor ?? FINANCIAL_FIXTURE.approved_amount_minor,
    currency: plan.currency ?? FINANCIAL_FIXTURE.currency,
  };
  const at = (offsetMs: number): number => setup.dispatch_ms + offsetMs;
  const registered = setup.caller.emit(
    'attempt_registered',
    setup.dispatch_ms - ATTEMPT_OFFSETS.registered_before_dispatch,
    { ...correlation, ...values, provider_qualifier: GOLDEN_PROVIDER_VERSION },
    [setup.invocation_event_id],
  );
  const dispatchEventId = setup.caller.emit(
    'dispatch_started',
    setup.dispatch_ms,
    {
      ...correlation,
      dispatch_at: instantAt(setup.dispatch_ms),
      deadline_at: instantAt(at(ATTEMPT_OFFSETS.timer_fired)),
      deadline_ns: '3000000000',
    },
    [registered],
  );
  const provider = env.log.instance('refund_provider', `call-${String(setup.number)}`);
  const receivedEventId = provider.emit('provider_call_received', at(ATTEMPT_OFFSETS.received), {
    provider_call_id: ids.provider_call_id,
    raw_request_sha256: labelDigest(`${prefix}/provider-request`),
    caller_id: env.context.caller,
    ...correlation,
    payment_id: values.payment_id,
  });
  return {
    env,
    setup,
    ids,
    correlation,
    values,
    provider,
    dispatch_event_id: dispatchEventId,
    received_event_id: receivedEventId,
    at,
  };
}

function succeeded(run: AttemptRun): AttemptResult {
  const confirmed = commit(run, false, ATTEMPT_OFFSETS.committed);
  const returnedMs = run.at(ATTEMPT_OFFSETS.response_returned);
  returnResponse(run, confirmed, returnedMs);
  const outcomeMs = run.at(ATTEMPT_OFFSETS.outcome_after_response);
  const outcomeEventId = run.setup.caller.emit(
    'attempt_outcome_recorded',
    outcomeMs,
    {
      ...run.correlation,
      outcome: 'SUCCEEDED',
      dispatch_state: 'DISPATCHED',
      provider_call_id: run.ids.provider_call_id,
      provider_transaction_id: run.ids.provider_transaction_id,
      executed_version: GOLDEN_PROVIDER_VERSION,
      dispatch_to_settlement_ns: nanos(ATTEMPT_OFFSETS.outcome_after_response - 10),
    },
    [run.dispatch_event_id],
  );
  return result(run, outcomeEventId, 'SUCCESS', outcomeMs);
}

function rejected(run: AttemptRun): AttemptResult {
  const reason = run.setup.plan.rejection_reason ?? 'PAYMENT_NOT_FOUND';
  const rejectedMs = run.at(ATTEMPT_OFFSETS.accepted);
  run.provider.emit(
    'provider_call_rejected',
    rejectedMs,
    {
      provider_call_id: run.ids.provider_call_id,
      reason,
      detail: `the call failed the ${reason} check of the acceptance order; expected an acceptable refund call`,
    },
    [run.received_event_id],
  );
  run.env.timeline.addProviderCall(run.at(ATTEMPT_OFFSETS.received), rejectedMs);
  const outcomeMs = run.at(90);
  const outcomeEventId = run.setup.caller.emit(
    'attempt_outcome_recorded',
    outcomeMs,
    {
      ...run.correlation,
      outcome: 'REJECTED',
      dispatch_state: 'DISPATCHED',
      provider_call_id: run.ids.provider_call_id,
      rejection_reason: reason,
      executed_version: GOLDEN_PROVIDER_VERSION,
      dispatch_to_settlement_ns: nanos(80),
    },
    [run.dispatch_event_id],
  );
  return result(run, outcomeEventId, 'REJECTION', outcomeMs);
}

function commitFailed(run: AttemptRun): AttemptResult {
  const accepted = accept(run);
  const failedMs = run.at(90);
  run.provider.emit(
    'provider_commit_failed',
    failedMs,
    {
      provider_commit_id: run.ids.provider_commit_id,
      provider_transaction_id: run.ids.provider_transaction_id,
      provider_call_id: run.ids.provider_call_id,
      targeted: false,
      error_code: 'TransactionCanceledException',
      detail: `commit ${run.ids.provider_commit_id} not applied: definitive failure TransactionCanceledException; expected applied`,
    },
    [accepted],
  );
  run.env.timeline.addProviderCall(run.at(ATTEMPT_OFFSETS.received), failedMs);
  const outcomeMs = run.at(120);
  const outcomeEventId = run.setup.caller.emit(
    'attempt_outcome_recorded',
    outcomeMs,
    {
      ...run.correlation,
      outcome: 'FAILED',
      dispatch_state: 'DISPATCHED',
      failure: { code: 'FUNCTION_ERROR', subject: 'BR-RUA-053', detail: 'function error "Unhandled"; expected none' },
      function_error: 'Unhandled',
      executed_version: GOLDEN_PROVIDER_VERSION,
      dispatch_to_settlement_ns: nanos(110),
    },
    [run.dispatch_event_id],
  );
  return result(run, outcomeEventId, 'AMBIGUOUS', outcomeMs);
}

// The three timeout behaviors share the caller side: the timer wins at D + 3000, the abort
// settles the transport at once (D-26), and the outcome cites the timeout record.
function timedOut(run: AttemptRun): AttemptResult {
  const behavior = run.setup.plan.behavior;
  // Plan checks admit the two targeted behaviors only as the first accepted call of a treatment.
  const confirmed = behavior === 'untargeted_timeout' ? undefined : commit(run, true, ATTEMPT_OFFSETS.committed);
  const timeoutEventId = recordCallerTimeout(run);
  if (confirmed === undefined) {
    lateUntargetedCommit(run, timeoutEventId);
  } else if (behavior === 'targeted_timeout') {
    signalAndRelease(run, confirmed, timeoutEventId);
  } else {
    safetyRelease(run, confirmed, timeoutEventId);
  }
  const outcomeMs = run.at(ATTEMPT_OFFSETS.timed_out_outcome);
  const outcomeEventId = run.setup.caller.emit(
    'attempt_outcome_recorded',
    outcomeMs,
    {
      ...run.correlation,
      outcome: 'TIMED_OUT',
      dispatch_state: 'DISPATCHED',
      dispatch_to_settlement_ns: TIMER_ELAPSED_NS,
    },
    [timeoutEventId],
  );
  return result(run, outcomeEventId, 'AMBIGUOUS', outcomeMs);
}

const TIMER_ELAPSED_NS = '3000400000';

function recordCallerTimeout(run: AttemptRun): Uuid4 {
  const timeoutEventId = run.setup.caller.emit(
    'caller_timeout_recorded',
    run.at(ATTEMPT_OFFSETS.timeout_recorded),
    {
      ...run.correlation,
      elapsed_ns: TIMER_ELAPSED_NS,
      monotonic_origin_event_id: run.dispatch_event_id,
      dispatch_at: instantAt(run.setup.dispatch_ms),
      deadline_at: instantAt(run.at(ATTEMPT_OFFSETS.timer_fired)),
      timer_fired_at: instantAt(run.at(ATTEMPT_OFFSETS.timer_fired)),
      abort_requested_at: instantAt(run.at(ATTEMPT_OFFSETS.abort_requested)),
      recorded_at: instantAt(run.at(ATTEMPT_OFFSETS.timeout_recorded)),
      arbiter_winner: 'TIMER',
      transport_settled_at_claim: false,
    },
    [run.dispatch_event_id],
  );
  run.setup.caller.emit(
    'transport_settled_after_timeout',
    run.at(ATTEMPT_OFFSETS.transport_settled),
    { ...run.correlation, settlement_kind: 'aborted', observed_after_elapsed_ns: '3003000000' },
    [run.dispatch_event_id],
  );
  return timeoutEventId;
}

function result(run: AttemptRun, outcomeEventId: Uuid4, outcomeClass: OutcomeClass, outcomeMs: number): AttemptResult {
  return {
    attempt_id: run.ids.attempt_id,
    outcome_event_id: outcomeEventId,
    outcome_class: outcomeClass,
    outcome_ms: outcomeMs,
  };
}
