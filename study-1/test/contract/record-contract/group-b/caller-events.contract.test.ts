// Caller-journal records (catalogue rows 19-28): the field rules that depend on the caller
// variant, the attempt outcome and the processing state (BR-RUA-012..021, BR-RUA-033).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import { ATTEMPT_FAILURE_CODES, DISPATCH_STATES } from '../../../../src/record-contract/records/group-b/vocabulary.ts';
import type { AttemptFailureCode, DispatchState } from '../../../../src/record-contract/records/group-b/vocabulary.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import * as caller from './examples/caller-examples.ts';
import {
  assertAccepted,
  assertForbidden,
  assertMissing,
  assertRejected,
} from '../../../support/record-contract/group-b-validation.ts';
import {
  objectAt,
  textOf,
  withMember,
  withValueAt,
  withoutMembers,
} from '../../../support/record-contract/json-paths.ts';
import { ATTEMPT_CORRELATION, toJson, uuid } from '../../../support/record-contract/record-builders.ts';

function json(record: StudyRecord): JsonObject {
  return toJson(record);
}

// The dispatch states each failure code admits. A pre-dispatch failure is NOT_DISPATCHED only
// when the conditional transition applied, UNKNOWN otherwise (BR-RUA-021; provider-client
// `#recordNotDispatched`); C3 condition_failed and ambiguous give UNKNOWN; §9.9 codes DISPATCHED.
const FAILURE_DISPATCH_STATES: readonly (readonly [AttemptFailureCode, readonly DispatchState[]])[] = [
  ['CALL_BUILD_FAILED', ['NOT_DISPATCHED', 'UNKNOWN']],
  ['DISPATCH_TRANSITION_REJECTED', ['NOT_DISPATCHED', 'UNKNOWN']],
  ['DISPATCH_TRANSITION_CONDITION_FAILED', ['UNKNOWN']],
  ['DISPATCH_TRANSITION_AMBIGUOUS', ['UNKNOWN']],
  ['FUNCTION_ERROR', ['DISPATCHED']],
  ['VERSION_MISMATCH', ['DISPATCHED']],
  ['MALFORMED_RESPONSE', ['DISPATCHED']],
  ['ABORTED_WITHOUT_DEADLINE', ['DISPATCHED']],
  ['TRANSPORT_ERROR', ['DISPATCHED']],
  ['TIMEOUT_RECORD_NOT_DURABLE', ['DISPATCHED']],
];

/** The canonical FAILED outcome with `code` and `state`; only a dispatched attempt keeps its time. */
function failedWith(code: AttemptFailureCode, state: DispatchState): JsonObject {
  const failed = withValueAt(json(caller.failedOutcome()), ['failure', 'code'], code);
  const stated = withMember(objectAt(failed, []), 'dispatch_state', state);
  return state === 'DISPATCHED' ? stated : withMember(stated, 'dispatch_to_settlement_ns', undefined);
}

describe('AC-RUA-046 caller_invocation_started', () => {
  it('queue-driven callers carry the SQS message identity', () => {
    for (const record of [json(caller.conventionalInvocationStarted()), json(caller.durableInvocationStarted())]) {
      const label = textOf(record['source'] ?? null);
      assertMissing(withMember(record, 'message_id', undefined), label, 'message_id');
      assertMissing(withMember(record, 'approximate_receive_count', undefined), label, 'approximate_receive_count');
      assertRejected(withMember(record, 'approximate_receive_count', 0), label, '/approximate_receive_count minimum');
    }
  });

  it('only the durable caller carries a durable execution', () => {
    const durable = json(caller.durableInvocationStarted());
    assertMissing(withMember(durable, 'durable_execution_arn', undefined), 'durable', 'durable_execution_arn');
    assertRejected(withMember(durable, 'step_attempt', 0), 'durable step 0', '/step_attempt minimum');
    const conventional = json(caller.conventionalInvocationStarted());
    const arn = caller.DURABLE_EXECUTION_ARN;
    assertForbidden(
      withMember(conventional, 'durable_execution_arn', arn),
      'conventional arn',
      '/durable_execution_arn',
    );
    assertForbidden(withMember(conventional, 'step_attempt', 1), 'conventional step', '/step_attempt');
  });

  it('the probe caller has no queue message', () => {
    const probe = json(caller.probeInvocationStarted());
    assertAccepted(probe, 'probe');
    assertForbidden(withMember(probe, 'message_id', 'message-0001'), 'probe message', '/message_id');
    assertForbidden(
      withMember(probe, 'approximate_receive_count', 1),
      'probe receive count',
      '/approximate_receive_count',
    );
    assertForbidden(
      withMember(probe, 'durable_execution_arn', caller.DURABLE_EXECUTION_ARN),
      'probe arn',
      '/durable_execution_arn',
    );
  });
});

describe('AC-RUA-046 attempt identity records', () => {
  it('the business identities are non-empty and trimmed', () => {
    const registered = json(caller.attemptRegistered());
    for (const field of ['refund_request_id', 'payment_id']) {
      for (const value of ['', ' refund-request-0001', 'refund-request-0001 ', '\t']) {
        assertRejected(withMember(registered, field, value), `${field} ${JSON.stringify(value)}`, `/${field} pattern`);
      }
    }
  });

  it('amounts, currency and qualifier are canonical', () => {
    const registered = json(caller.attemptRegistered());
    assertRejected(withMember(registered, 'amount_minor', 0), 'zero amount', '/amount_minor minimum');
    for (const currency of ['EURO', 'EU', 'E1R']) {
      assertRejected(withMember(registered, 'currency', currency), currency, '/currency pattern');
    }
    for (const qualifier of ['0', '07', '$LATEST', '1.0']) {
      assertRejected(withMember(registered, 'provider_qualifier', qualifier), qualifier, '/provider_qualifier pattern');
    }
  });

  it('a pre-dispatch failure names only a pre-dispatch code', () => {
    const notDispatched = json(caller.attemptNotDispatched());
    assertAccepted(withValueAt(notDispatched, ['failure', 'code'], 'DISPATCH_TRANSITION_REJECTED'), 'transition');
    for (const code of ['TRANSPORT_ERROR', 'FUNCTION_ERROR', 'TIMEOUT_RECORD_NOT_DURABLE']) {
      assertRejected(withValueAt(notDispatched, ['failure', 'code'], code), code, '/failure/code enum');
    }
    assertMissing(withMember(notDispatched, 'failure', undefined), 'no failure', 'failure');
  });
});

describe('AC-RUA-046 caller_timeout_recorded', () => {
  it('is caused by the dispatch it times out, in canonical causation order', () => {
    const timeout = json(caller.callerTimeoutRecorded());
    assertMissing(withMember(timeout, 'causation_event_ids', undefined), 'no causation', 'causation_event_ids');
    assertRejected(withMember(timeout, 'causation_event_ids', []), 'empty causation', '/causation_event_ids minItems');
    assertRejected(withMember(timeout, 'causation_event_ids', [uuid(5), uuid(3)]), 'unsorted causation');
    assertRejected(withMember(timeout, 'causation_event_ids', [uuid(5), uuid(5)]), 'duplicate causation');
    assertAccepted(withMember(timeout, 'causation_event_ids', [uuid(3), uuid(5)]), 'sorted causation');
  });

  it('records the arbiter outcome as observed, for the oracle to judge (BR-RUA-011)', () => {
    const timeout = json(caller.callerTimeoutRecorded());
    assertAccepted(withMember(timeout, 'arbiter_winner', 'TRANSPORT'), 'transport won');
    assertAccepted(withMember(timeout, 'transport_settled_at_claim', true), 'settled at claim');
    assertRejected(withMember(timeout, 'arbiter_winner', 'NONE'), 'unknown winner', '/arbiter_winner enum');
  });

  it('the runner writes one only at execution level, in the canary partition (D-10)', () => {
    const timeout = json(caller.callerTimeoutRecorded());
    const executionLevel = withoutMembers(timeout, ['trial_id', 'trial_manifest_sha256']);
    assertAccepted(withMember(executionLevel, 'source', 'runner'), 'runner canary');
    const inTrial = withMember(timeout, 'source', 'runner');
    assertForbidden(inTrial, 'runner inside a trial', '/trial_id');
    assertForbidden(inTrial, 'runner inside a trial', '/trial_manifest_sha256');
  });
});

describe('AC-RUA-046 attempt_outcome_recorded', () => {
  it('a provider answer or a caller timeout implies the call was dispatched', () => {
    for (const record of [caller.succeededOutcome(), caller.rejectedOutcome(), caller.timedOutOutcome()]) {
      for (const state of ['NOT_DISPATCHED', 'UNKNOWN']) {
        assertRejected(
          withMember(json(record), 'dispatch_state', state),
          `${record.outcome} ${state}`,
          '/dispatch_state const',
        );
      }
    }
    for (const [code, states] of FAILURE_DISPATCH_STATES) {
      for (const state of states) {
        assertAccepted(failedWith(code, state), `FAILED ${code} ${state}`);
      }
    }
  });

  it('each failure code fixes the dispatch state (design §5.3 C2/C3, §9.9)', () => {
    let checked = 0;
    for (const [code, states] of FAILURE_DISPATCH_STATES) {
      for (const state of DISPATCH_STATES.filter((candidate) => !states.includes(candidate))) {
        assertRejected(failedWith(code, state), `FAILED ${code} ${state}`, '/dispatch_state');
        checked += 1;
      }
    }
    // 2 pre-dispatch codes x 1 + 2 transition codes x 2 + 6 transport-side codes x 2.
    assert.equal(checked, 18);
    assert.deepEqual(
      FAILURE_DISPATCH_STATES.map(([code]) => code),
      [...ATTEMPT_FAILURE_CODES],
    );
  });

  it('a dispatch-to-settlement time exists exactly when the attempt was dispatched', () => {
    for (const record of [caller.succeededOutcome(), caller.rejectedOutcome(), caller.timedOutOutcome()]) {
      const label = `${record.outcome} without a settlement time`;
      assertMissing(
        withMember(json(record), 'dispatch_to_settlement_ns', undefined),
        label,
        'dispatch_to_settlement_ns',
      );
    }
    const dispatched = failedWith('TRANSPORT_ERROR', 'DISPATCHED');
    assertMissing(
      withMember(dispatched, 'dispatch_to_settlement_ns', undefined),
      'FAILED DISPATCHED without a settlement time',
      'dispatch_to_settlement_ns',
    );
    for (const [code, state] of [
      ['CALL_BUILD_FAILED', 'NOT_DISPATCHED'],
      ['DISPATCH_TRANSITION_AMBIGUOUS', 'UNKNOWN'],
    ] as const) {
      const timed = withMember(failedWith(code, state), 'dispatch_to_settlement_ns', '1');
      assertForbidden(timed, `${state} with a settlement time`, '/dispatch_to_settlement_ns');
    }
  });

  it('SUCCEEDED names the provider call and transaction', () => {
    const succeeded = json(caller.succeededOutcome());
    assertMissing(withMember(succeeded, 'provider_call_id', undefined), 'no call', 'provider_call_id');
    assertMissing(
      withMember(succeeded, 'provider_transaction_id', undefined),
      'no transaction',
      'provider_transaction_id',
    );
    assertForbidden(withMember(succeeded, 'rejection_reason', 'AMOUNT_INVALID'), 'with rejection', '/rejection_reason');
  });

  it('REJECTED names the call and the reason, and no transaction', () => {
    const rejected = json(caller.rejectedOutcome());
    assertMissing(withMember(rejected, 'rejection_reason', undefined), 'no reason', 'rejection_reason');
    assertMissing(withMember(rejected, 'provider_call_id', undefined), 'no call', 'provider_call_id');
    assertForbidden(
      withMember(rejected, 'provider_transaction_id', uuid(0x401)),
      'with tx',
      '/provider_transaction_id',
    );
    assertRejected(
      withMember(rejected, 'rejection_reason', 'NOT_A_REASON'),
      'unknown reason',
      '/rejection_reason enum',
    );
  });

  it('only FAILED carries a failure, and FAILED always does', () => {
    const failure = { code: 'FUNCTION_ERROR', subject: 'invoke', detail: 'Unhandled; expected a response' };
    assertMissing(withMember(json(caller.failedOutcome()), 'failure', undefined), 'FAILED', 'failure');
    for (const record of [caller.succeededOutcome(), caller.rejectedOutcome(), caller.timedOutOutcome()]) {
      assertForbidden(withMember(json(record), 'failure', failure), `${record.outcome} failure`, '/failure');
    }
    assertRejected(
      withValueAt(json(caller.failedOutcome()), ['failure', 'code'], 'BOOM'),
      'unknown code',
      '/failure/code enum',
    );
  });
});

describe('AC-RUA-046 request_state_recorded', () => {
  it('a terminal reason exists exactly when processing is FINISHED', () => {
    const finished = json(caller.finishedRequestState());
    assertMissing(
      withMember(finished, 'processing_terminal_reason', undefined),
      'FINISHED',
      'processing_terminal_reason',
    );
    for (const state of ['NOT_STARTED', 'RUNNING']) {
      assertForbidden(withMember(finished, 'processing_state', state), state, '/processing_terminal_reason');
      assertAccepted(withMember(json(caller.runningRequestState()), 'processing_state', state), state);
    }
  });

  it('names the refund request unless the message itself was rejected', () => {
    const finished = json(caller.finishedRequestState());
    assertMissing(withMember(finished, 'refund_request_id', undefined), 'FINISHED', 'refund_request_id');
    assertMissing(
      withMember(json(caller.runningRequestState()), 'refund_request_id', undefined),
      'RUNNING',
      'refund_request_id',
    );
    const rejected = withMember(json(caller.messageRejectedRequestState()), 'refund_request_id', undefined);
    assertAccepted(rejected, 'MESSAGE_REJECTED without an identity');
  });

  it('versions start at 1 and attempt ids are unique', () => {
    const finished = json(caller.finishedRequestState());
    assertRejected(withMember(finished, 'version', 0), 'version 0', '/version minimum');
    const attempt = ATTEMPT_CORRELATION.attempt_id;
    assertRejected(withMember(finished, 'attempt_ids', [attempt, attempt]), 'duplicate', '/attempt_ids uniqueItems');
  });
});

describe('AC-RUA-046 inner_execution_exhausted and trial_message_rejected', () => {
  it('counts at least one step attempt and receive', () => {
    const exhausted = json(caller.innerExecutionExhausted());
    assertRejected(withMember(exhausted, 'step_attempts', 0), 'no attempts', '/step_attempts minimum');
    assertRejected(
      withMember(exhausted, 'approximate_receive_count', 0),
      'no receive',
      '/approximate_receive_count minimum',
    );
  });

  it('keeps the rejected input verbatim, empty strings included', () => {
    const rejected = json(caller.trialMessageRejected());
    assertAccepted(withMember(rejected, 'offending_value', ''), 'empty offending value');
    assertAccepted(withMember(rejected, 'expected_value', 'ABC'), 'arbitrary expected value');
    assertRejected(withMember(rejected, 'offending_value', 7), 'non-string offending value', '/offending_value type');
    assertRejected(withMember(rejected, 'reason', 'UNKNOWN'), 'unknown reason', '/reason enum');
  });
});
