// ProviderClient.performAttempt end to end over named fakes: each transport settlement of
// design §9.9 becomes the documented outcome, report and `attempt_outcome_recorded` event, and
// C1 refuses inputs and registrations that leave no attempt to report on.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AttemptNotRegisteredError } from '../../../src/provider-client/provider-client.ts';
import { dispatchStartedBody } from '../../support/event-journal/journal-fixtures.ts';
import {
  attemptInput,
  CAUSE_EVENT_ID,
  FIRST_ATTEMPT_ID,
  FIRST_PROVIDER_REQUEST_ID,
  invokeResponse,
  journalEvents,
  jsonBytes,
  MS,
  onlyEvent,
  PROVIDER_CALL_ID,
  PROVIDER_QUALIFIER,
  PROVIDER_TRANSACTION_ID,
  recordingHarness,
  rejectedResponder,
  settleAttempt,
  succeededResponder,
} from '../../support/provider-client/provider-client-fixtures.ts';

describe('ProviderClient outcomes', () => {
  it('a SUCCEEDED response is SUCCEEDED/DISPATCHED with the provider ids', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(1_200n * MS, succeededResponder);
    const report = await settleAttempt(harness);
    const outcome = onlyEvent(journalEvents(harness), 'attempt_outcome_recorded');
    assert.deepEqual(report, {
      attempt_id: FIRST_ATTEMPT_ID,
      provider_request_id: FIRST_PROVIDER_REQUEST_ID,
      outcome: 'SUCCEEDED',
      dispatch_state: 'DISPATCHED',
      outcome_class: 'SUCCESS',
      provider_call_id: PROVIDER_CALL_ID,
      provider_transaction_id: PROVIDER_TRANSACTION_ID,
      dispatch_to_settlement_ns: '1200000000',
      outcome_event_id: outcome.event_id,
    });
    assert.equal(outcome.outcome, 'SUCCEEDED');
    assert.equal(outcome.executed_version, PROVIDER_QUALIFIER);
    assert.equal(outcome.refund_request_id, 'ref-poc-001');
    assert.equal('function_error' in outcome, false);
  });

  it('sends the call built from the input and the trial scope', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(MS, succeededResponder);
    await settleAttempt(harness);
    assert.deepEqual(harness.invoker.invocations()[0]?.call, {
      caller_id: 'conventional',
      run_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      trial_id: 'bbbbbbbb-0000-4000-8000-000000000001',
      trial_manifest_sha256: 'b'.repeat(64),
      schema_version: 1,
      record_type: 'provider_refund_call',
      execution_manifest_sha256: 'a'.repeat(64),
      attempt_id: FIRST_ATTEMPT_ID,
      provider_request_id: FIRST_PROVIDER_REQUEST_ID,
      refund_request_id: 'ref-poc-001',
      payment_id: 'pay-poc-001',
      amount_minor: 10000,
      currency: 'BRL',
    });
  });

  it('a REJECTED response is REJECTED/DISPATCHED with the rejection reason', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(MS, rejectedResponder('PAYMENT_NOT_FOUND'));
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'REJECTED');
    assert.equal(report.outcome_class, 'REJECTION');
    assert.equal(report.rejection_reason, 'PAYMENT_NOT_FOUND');
    assert.equal(report.provider_call_id, PROVIDER_CALL_ID);
    assert.equal(report.provider_transaction_id, undefined);
    const outcome = onlyEvent(journalEvents(harness), 'attempt_outcome_recorded');
    assert.equal(outcome.outcome, 'REJECTED');
    assert.equal(outcome.rejection_reason, 'PAYMENT_NOT_FOUND');
  });

  it('a function error is FAILED/DISPATCHED and keeps the raw value on the outcome event', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(MS, () => ({
      ...invokeResponse(jsonBytes({ errorMessage: 'boom' })),
      function_error: 'Unhandled',
    }));
    const report = await settleAttempt(harness);
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.dispatch_state, 'DISPATCHED');
    assert.equal(report.failure?.code, 'FUNCTION_ERROR');
    const outcome = onlyEvent(journalEvents(harness), 'attempt_outcome_recorded');
    assert.equal(outcome.function_error, 'Unhandled');
    assert.equal(outcome.executed_version, PROVIDER_QUALIFIER);
    assert.equal('function_error' in report, false);
  });

  it('a response from another version is FAILED with VERSION_MISMATCH', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(MS, (call) => ({ ...succeededResponder(call), executed_version: '8' }));
    const report = await settleAttempt(harness);
    assert.equal(report.failure?.code, 'VERSION_MISMATCH');
    assert.equal(report.provider_transaction_id, undefined);
  });

  it('a response that does not echo the request ids is FAILED with MALFORMED_RESPONSE', async () => {
    const harness = recordingHarness();
    harness.invoker.resolveAfter(MS, (call) => succeededResponder({ ...call, attempt_id: CAUSE_EVENT_ID }));
    const report = await settleAttempt(harness);
    assert.equal(report.failure?.code, 'MALFORMED_RESPONSE');
    assert.equal(
      report.failure.detail,
      `attempt_id string "${CAUSE_EVENT_ID}"; expected the request's ${FIRST_ATTEMPT_ID}`,
    );
  });

  it('a port whose promise rejects is a TRANSPORT_ERROR, still DISPATCHED', async () => {
    const harness = recordingHarness();
    harness.invoker.rejectAfter(5n * MS, Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }));
    const report = await settleAttempt(harness);
    assert.equal(report.dispatch_state, 'DISPATCHED');
    assert.equal(
      report.failure?.detail,
      'transport_error:"TimeoutError": "socket hang up"; expected a provider response',
    );
    assert.equal(report.dispatch_to_settlement_ns, '5000000');
  });

  it('rejects an input the attempt records could not hold before writing anything', async () => {
    const harness = recordingHarness();
    await assert.rejects(harness.client.performAttempt(attemptInput({ amount_minor: 0 })), {
      name: 'RangeError',
      message: 'invalid attempt input: amount_minor 0; expected a safe integer >= 1',
    });
    assert.deepEqual(harness.recorder.calls(), []);
    assert.deepEqual(harness.port.entries(), []);
  });

  for (const [fault, registration] of [
    [{ kind: 'ambiguous', code: 'RequestTimeout', applied: true }, 'ambiguous'],
    [{ kind: 'definitive_failure', code: 'ValidationException' }, 'rejected'],
    [{ kind: 'condition_failed' }, 'condition_failed'],
  ] as const) {
    it(`a ${registration} registration throws AttemptNotRegisteredError and never dispatches`, async () => {
      const harness = recordingHarness();
      harness.recorder.scriptNext('registerPreDispatch', fault);
      await assert.rejects(harness.client.performAttempt(attemptInput()), (error: unknown) => {
        assert.ok(error instanceof AttemptNotRegisteredError);
        assert.equal(error.name, 'AttemptNotRegisteredError');
        assert.equal(error.attempt_id, FIRST_ATTEMPT_ID);
        assert.equal(error.registration, registration);
        assert.equal(
          error.message,
          `attempt ${FIRST_ATTEMPT_ID} registration ${registration}; expected the PRE_DISPATCH registration to apply`,
        );
        return true;
      });
      assert.equal(harness.recorder.calls().length, 1);
      assert.equal(harness.invoker.invocations().length, 0);
    });
  }

  it('a journal instance that already stopped cannot register an attempt', async () => {
    const harness = recordingHarness();
    harness.port.throwNext(new Error('lost'));
    await harness.journal.append('dispatch_started', dispatchStartedBody());
    assert.equal(harness.journal.isStopped(), true);
    await assert.rejects(harness.client.performAttempt(attemptInput()), { registration: 'ambiguous' });
    assert.deepEqual(harness.recorder.calls(), []);
  });
});
