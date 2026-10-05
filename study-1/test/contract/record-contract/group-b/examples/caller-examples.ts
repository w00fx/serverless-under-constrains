// Canonical caller-journal examples (catalogue rows 19-28): one conventional trial of the run,
// attempt `ATTEMPT_CORRELATION`, timed out after commit, as BR-RUA-012..021 describe it.

import type { AttemptNotDispatched } from '../../../../../src/record-contract/records/group-b/attempt_not_dispatched.ts';
import type {
  FailedOutcome,
  RejectedOutcome,
  SucceededOutcome,
  TimedOutOutcome,
} from '../../../../../src/record-contract/records/group-b/attempt_outcome_recorded.ts';
import type { AttemptRegistered } from '../../../../../src/record-contract/records/group-b/attempt_registered.ts';
import type {
  ConventionalInvocationStarted,
  DurableInvocationStarted,
  ProbeInvocationStarted,
} from '../../../../../src/record-contract/records/group-b/caller_invocation_started.ts';
import type { CallerTimeoutRecorded } from '../../../../../src/record-contract/records/group-b/caller_timeout_recorded.ts';
import type { DispatchStarted } from '../../../../../src/record-contract/records/group-b/dispatch_started.ts';
import type { InnerExecutionExhausted } from '../../../../../src/record-contract/records/group-b/inner_execution_exhausted.ts';
import type {
  FinishedRequestState,
  MessageRejectedRequestState,
  OpenRequestState,
} from '../../../../../src/record-contract/records/group-b/request_state_recorded.ts';
import type { TransportSettledAfterTimeout } from '../../../../../src/record-contract/records/group-b/transport_settled_after_timeout.ts';
import type { TrialMessageRejected } from '../../../../../src/record-contract/records/group-b/trial_message_rejected.ts';
import {
  ATTEMPT_CORRELATION,
  COMMIT_TRIPLE,
  PAYMENT_ID,
  TRIAL_MANIFEST_SHA256,
  at,
  digest,
  executionEnvelope,
  ns,
  trialEnvelope,
  uuid,
} from '../support/record-builders.ts';
import { example } from '../support/record-example.ts';
import type { RecordExample } from '../support/record-example.ts';

/** The durable execution every durable example belongs to. */
export const DURABLE_EXECUTION_ARN =
  'arn:aws:lambda:eu-west-1:111122223333:function:rua-durable-caller:7/durable-execution/refund-0001/run-1';
const DISPATCH_EVENT_ID = uuid(5);

/** The conventional caller starting on an SQS receive. */
export function conventionalInvocationStarted(): ConventionalInvocationStarted {
  return {
    ...trialEnvelope('caller_invocation_started', 1, 1),
    source: 'conventional_caller',
    lambda_request_id: '7f9c1a2e-request',
    message_id: 'message-0001',
    approximate_receive_count: 1,
  };
}

/** The durable caller starting a replayed step of its execution. */
export function durableInvocationStarted(): DurableInvocationStarted {
  return {
    ...trialEnvelope('caller_invocation_started', 1, 1),
    source: 'durable_caller',
    lambda_request_id: '7f9c1a2e-request',
    message_id: 'message-0001',
    approximate_receive_count: 1,
    durable_execution_arn: DURABLE_EXECUTION_ARN,
    step_attempt: 2,
  };
}

/** The transport probe caller, invoked directly (no queue message). */
export function probeInvocationStarted(): ProbeInvocationStarted {
  return {
    ...executionEnvelope('caller_invocation_started', 'probe', 1, 1),
    source: 'probe_caller',
    lambda_request_id: '7f9c1a2e-request',
  };
}

/** A trial message refused before any attempt, with the offending value kept verbatim. */
export function trialMessageRejected(): TrialMessageRejected {
  return {
    ...trialEnvelope('trial_message_rejected', 2, 2),
    source: 'conventional_caller',
    message_id: 'message-0001',
    message_body_sha256: digest('message-body'),
    reason: 'TRIAL_MANIFEST_DIGEST_MISMATCH',
    detail: 'message trial_manifest_sha256 differs from the active trial; expected the active digest',
    offending_value: digest('other-trial-manifest'),
    expected_value: TRIAL_MANIFEST_SHA256,
    refund_request_id: ATTEMPT_CORRELATION.refund_request_id,
    payment_id: PAYMENT_ID,
  };
}

/** A new attempt and the refund it requests. */
export function attemptRegistered(): AttemptRegistered {
  return {
    ...trialEnvelope('attempt_registered', 3, 3),
    causation_event_ids: [uuid(1)],
    source: 'conventional_caller',
    ...ATTEMPT_CORRELATION,
    payment_id: PAYMENT_ID,
    amount_minor: 1250,
    currency: 'EUR',
    provider_qualifier: '7',
  };
}

/** An attempt that failed before the call left the caller. */
export function attemptNotDispatched(): AttemptNotDispatched {
  return {
    ...trialEnvelope('attempt_not_dispatched', 4, 4),
    source: 'conventional_caller',
    ...ATTEMPT_CORRELATION,
    failure: { code: 'CALL_BUILD_FAILED', subject: 'provider_request', detail: 'signing failed; expected a request' },
  };
}

/** The dispatch of an attempt with its monotonic deadline. */
export function dispatchStarted(): DispatchStarted {
  return {
    ...trialEnvelope('dispatch_started', 5, 4),
    source: 'conventional_caller',
    ...ATTEMPT_CORRELATION,
    dispatch_at: at(10),
    deadline_at: at(3010),
    deadline_ns: ns(3_000_000_000n),
  };
}

/** The caller timeout of the dispatched attempt, timer won. */
export function callerTimeoutRecorded(): CallerTimeoutRecorded {
  return {
    ...trialEnvelope('caller_timeout_recorded', 6, 5),
    source: 'conventional_caller',
    causation_event_ids: [DISPATCH_EVENT_ID],
    ...ATTEMPT_CORRELATION,
    elapsed_ns: ns(3_000_412_000n),
    monotonic_origin_event_id: DISPATCH_EVENT_ID,
    dispatch_at: at(10),
    deadline_at: at(3010),
    timer_fired_at: at(3010),
    abort_requested_at: at(3011),
    recorded_at: at(3012),
    arbiter_winner: 'TIMER',
    transport_settled_at_claim: false,
  };
}

/** The transport settling after the timeout claim. */
export function transportSettledAfterTimeout(): TransportSettledAfterTimeout {
  return {
    ...trialEnvelope('transport_settled_after_timeout', 7, 6),
    source: 'conventional_caller',
    ...ATTEMPT_CORRELATION,
    settlement_kind: 'aborted',
    observed_after_elapsed_ns: ns(3_000_900_000n),
  };
}

/** An attempt the provider committed and answered. */
export function succeededOutcome(): SucceededOutcome {
  return {
    ...trialEnvelope('attempt_outcome_recorded', 8, 7),
    source: 'conventional_caller',
    ...ATTEMPT_CORRELATION,
    outcome: 'SUCCEEDED',
    dispatch_state: 'DISPATCHED',
    provider_call_id: COMMIT_TRIPLE.provider_call_id,
    provider_transaction_id: COMMIT_TRIPLE.provider_transaction_id,
    dispatch_to_settlement_ns: ns(812_000_000n),
    executed_version: '7',
  };
}

/** An attempt the provider rejected. */
export function rejectedOutcome(): RejectedOutcome {
  return {
    ...trialEnvelope('attempt_outcome_recorded', 8, 7),
    source: 'conventional_caller',
    ...ATTEMPT_CORRELATION,
    outcome: 'REJECTED',
    dispatch_state: 'DISPATCHED',
    provider_call_id: COMMIT_TRIPLE.provider_call_id,
    rejection_reason: 'PAYMENT_NOT_FOUND',
  };
}

/** An attempt that timed out after dispatch. */
export function timedOutOutcome(): TimedOutOutcome {
  return {
    ...trialEnvelope('attempt_outcome_recorded', 8, 7),
    source: 'conventional_caller',
    ...ATTEMPT_CORRELATION,
    outcome: 'TIMED_OUT',
    dispatch_state: 'DISPATCHED',
    provider_call_id: COMMIT_TRIPLE.provider_call_id,
  };
}

/** An attempt that failed with an unknown dispatch state. */
export function failedOutcome(): FailedOutcome {
  return {
    ...trialEnvelope('attempt_outcome_recorded', 8, 7),
    source: 'conventional_caller',
    ...ATTEMPT_CORRELATION,
    outcome: 'FAILED',
    dispatch_state: 'UNKNOWN',
    failure: { code: 'TRANSPORT_ERROR', subject: 'invoke', detail: 'socket reset; expected a response' },
    function_error: 'Unhandled',
  };
}

/** The refund request finished with exactly one confirmed effect. */
export function finishedRequestState(): FinishedRequestState {
  return {
    ...trialEnvelope('request_state_recorded', 9, 8),
    source: 'conventional_caller',
    refund_request_id: ATTEMPT_CORRELATION.refund_request_id,
    version: 3,
    processing_state: 'FINISHED',
    processing_terminal_reason: 'SUCCEEDED',
    effect_knowledge: 'ONE_EFFECT_CONFIRMED',
    attempt_ids: [ATTEMPT_CORRELATION.attempt_id],
  };
}

/** The refund request still running. */
export function runningRequestState(): OpenRequestState {
  return {
    ...trialEnvelope('request_state_recorded', 9, 8),
    source: 'conventional_caller',
    refund_request_id: ATTEMPT_CORRELATION.refund_request_id,
    version: 2,
    processing_state: 'RUNNING',
    effect_knowledge: 'UNKNOWN',
    attempt_ids: [ATTEMPT_CORRELATION.attempt_id],
  };
}

/** The refund request finished because its message was rejected. */
export function messageRejectedRequestState(): MessageRejectedRequestState {
  return {
    ...trialEnvelope('request_state_recorded', 9, 8),
    source: 'conventional_caller',
    refund_request_id: ATTEMPT_CORRELATION.refund_request_id,
    version: 1,
    processing_state: 'FINISHED',
    processing_terminal_reason: 'MESSAGE_REJECTED',
    effect_knowledge: 'NOT_ATTEMPTED',
    attempt_ids: [],
  };
}

/** The durable caller exhausting its inner step attempts. */
export function innerExecutionExhausted(): InnerExecutionExhausted {
  return {
    ...trialEnvelope('inner_execution_exhausted', 10, 9),
    source: 'durable_caller',
    refund_request_id: ATTEMPT_CORRELATION.refund_request_id,
    durable_execution_arn: DURABLE_EXECUTION_ARN,
    step_attempts: 3,
    approximate_receive_count: 1,
    last_attempt_id: ATTEMPT_CORRELATION.attempt_id,
  };
}

export const CALLER_EXAMPLES: readonly RecordExample[] = [
  example('caller_invocation_started conventional', conventionalInvocationStarted()),
  example('caller_invocation_started durable', durableInvocationStarted(), { optional: ['step_attempt'] }),
  example('caller_invocation_started probe', probeInvocationStarted()),
  example('trial_message_rejected', trialMessageRejected(), {
    optional: ['offending_value', 'expected_value', 'refund_request_id', 'payment_id'],
    verbatim: ['offending_value', 'expected_value'],
  }),
  example('attempt_registered', attemptRegistered(), { optional: ['causation_event_ids'] }),
  example('attempt_not_dispatched', attemptNotDispatched()),
  example('dispatch_started', dispatchStarted()),
  example('caller_timeout_recorded', callerTimeoutRecorded()),
  example('transport_settled_after_timeout', transportSettledAfterTimeout()),
  example('attempt_outcome_recorded SUCCEEDED', succeededOutcome(), {
    optional: ['dispatch_to_settlement_ns', 'executed_version'],
  }),
  example('attempt_outcome_recorded REJECTED', rejectedOutcome()),
  example('attempt_outcome_recorded TIMED_OUT', timedOutOutcome(), { optional: ['provider_call_id'] }),
  example('attempt_outcome_recorded FAILED', failedOutcome(), { optional: ['function_error'] }),
  example('request_state_recorded FINISHED', finishedRequestState()),
  example('request_state_recorded RUNNING', runningRequestState()),
  example('request_state_recorded MESSAGE_REJECTED', messageRejectedRequestState(), {
    optional: ['refund_request_id'],
  }),
  example('inner_execution_exhausted', innerExecutionExhausted(), { optional: ['last_attempt_id'] }),
];
