// The Durable caller's step attempts over the caller journal and the shared provider client, on
// virtual time (BR-RUA-020, BR-RUA-024, BR-RUA-004, BR-RUA-033; AC-RUA-003, AC-RUA-045 and
// AC-RUA-053 feed). Each call of `runStepAttempt` is one step attempt in its own Lambda
// invocation, as the SDK runs it. Expected states come from the spec: a definitive answer
// completes the step; any other outcome fails the step attempt with processing RUNNING; an
// exhausted inner execution stays RUNNING while the source can redeliver, and only the last
// receive's exhaustion finishes RETRIES_EXHAUSTED (design §8.7).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StepAttemptFailed } from '../../../src/durable-variant/durable-fault.ts';
import type { FailedStepAttempt } from '../../../src/durable-variant/durable-fault.ts';
import {
  rejectedResponder,
  succeededResponder,
  transportError,
} from '../../support/provider-client/provider-client-fixtures.ts';
import {
  PAYMENT_ID,
  REFUND_REQUEST_ID,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_PK,
} from '../../unit/trial-message/support/trial-message-fixtures.ts';
import type { DurableHarness } from './support/durable-harness.ts';
import {
  DEFINITIVE,
  EXECUTION_ARN,
  MESSAGE_ID,
  TENTH_SECOND_NS,
  assertEventsConform,
  durableDelivery,
  durableHarness,
  eventsOfType,
  failedStep,
  faultAfterEvent,
  invocationOf,
  recordTypes,
  requestStates,
  runStep,
} from './support/durable-harness.ts';

function failedAttempt(thrown: unknown): FailedStepAttempt {
  assert.ok(thrown instanceof StepAttemptFailed, String(thrown));
  return thrown.failed;
}

function ambiguousAnswer(harness: DurableHarness): void {
  harness.invoker.resolveAfter(TENTH_SECOND_NS, () => transportError('TooManyRequestsException', 'Rate exceeded', 429));
}

/** Two step attempts of one execution on receive `receiveCount`, both ending ambiguous. */
async function exhaustExecution(harness: DurableHarness, receiveCount: number): Promise<readonly unknown[]> {
  ambiguousAnswer(harness);
  ambiguousAnswer(harness);
  const delivery = durableDelivery({ approximate_receive_count: receiveCount });
  return [await failedStep(harness, delivery, invocationOf(1)), await failedStep(harness, delivery, invocationOf(2))];
}

describe('DurableRefundCaller step attempts', () => {
  it('completes a control step attempt: one attempt, SUCCEEDED, one confirmed effect', async () => {
    const harness = durableHarness();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);

    assert.deepEqual(await runStep(harness, durableDelivery(), invocationOf(1)), { terminal_reason: 'SUCCEEDED' });
    assert.deepEqual(recordTypes(harness), [
      'caller_invocation_started',
      'attempt_registered',
      'dispatch_started',
      'attempt_outcome_recorded',
      'request_state_recorded',
    ]);
    const [started] = eventsOfType(harness, 'caller_invocation_started');
    assert.deepEqual(
      { ...started, event_id: undefined, source_instance_id: undefined, occurred_at: undefined },
      {
        schema_version: 1,
        record_type: 'caller_invocation_started',
        event_id: undefined,
        run_id: RUN_ID,
        execution_manifest_sha256: started?.execution_manifest_sha256,
        trial_id: TRIAL_ID,
        trial_manifest_sha256: TRIAL_MANIFEST_SHA,
        occurred_at: undefined,
        source: 'durable_caller',
        source_instance_id: undefined,
        source_sequence: 1,
        lambda_request_id: 'lambda-request-step-1',
        message_id: MESSAGE_ID,
        approximate_receive_count: 1,
        durable_execution_arn: EXECUTION_ARN,
        step_attempt: 1,
      },
    );
    const [registered] = eventsOfType(harness, 'attempt_registered');
    assert.deepEqual(registered?.causation_event_ids, [started?.event_id]);
    const [outcome] = eventsOfType(harness, 'attempt_outcome_recorded');
    const [state] = eventsOfType(harness, 'request_state_recorded');
    assert.deepEqual(state?.causation_event_ids, [outcome?.event_id]);
    assert.deepEqual(requestStates(harness), [
      {
        version: 1,
        processing_state: 'FINISHED',
        processing_terminal_reason: 'SUCCEEDED',
        effect_knowledge: 'ONE_EFFECT_CONFIRMED',
        attempt_ids: [registered.attempt_id],
      },
    ]);
    const [invocation] = harness.invoker.invocations();
    assert.deepEqual(
      {
        caller: invocation?.call.caller_id,
        run: invocation?.call.run_id,
        trial: invocation?.call.trial_id,
        refund: invocation?.call.refund_request_id,
        payment: invocation?.call.payment_id,
        amount: invocation?.call.amount_minor,
        currency: invocation?.call.currency,
      },
      {
        caller: 'durable',
        run: RUN_ID,
        trial: TRIAL_ID,
        refund: REFUND_REQUEST_ID,
        payment: PAYMENT_ID,
        amount: 10000,
        currency: 'BRL',
      },
    );
    assert.deepEqual([...new Set(harness.store.itemsIn('caller_journal').map((item) => item.pk))], [TRIAL_PK]);
    assertEventsConform(harness);
  });

  it('completes a provider rejection as PROVIDER_REJECTED with no effect confirmed', async () => {
    const harness = durableHarness();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, rejectedResponder('AUTHORIZATION_FAILED'));

    assert.deepEqual(await runStep(harness, durableDelivery(), invocationOf(1)), {
      terminal_reason: 'PROVIDER_REJECTED',
    });
    assert.deepEqual(
      requestStates(harness).map((state) => [
        state.processing_state,
        state.processing_terminal_reason,
        state.effect_knowledge,
      ]),
      [['FINISHED', 'PROVIDER_REJECTED', 'NO_EFFECT_CONFIRMED']],
    );
    assert.deepEqual(eventsOfType(harness, 'inner_execution_exhausted'), []);
    assertEventsConform(harness);
  });

  it('retries a timed-out step attempt: RUNNING and UNKNOWN, then SUCCEEDED with UNKNOWN kept (AC-RUA-003 feed)', async () => {
    const harness = durableHarness();
    harness.invoker.hang();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    const delivery = durableDelivery();

    const thrown = await failedStep(harness, delivery, invocationOf(1));
    const [first] = eventsOfType(harness, 'attempt_registered');
    assert.deepEqual(failedAttempt(thrown), {
      lambda_request_id: 'lambda-request-step-1',
      durable_execution_arn: EXECUTION_ARN,
      step_attempt: 1,
      attempt_id: first?.attempt_id,
      outcome_class: 'AMBIGUOUS',
    });
    assert.deepEqual(await runStep(harness, delivery, invocationOf(2)), { terminal_reason: 'SUCCEEDED' });

    const attempts = eventsOfType(harness, 'attempt_registered').map((event) => event.attempt_id);
    assert.equal(attempts.length, 2);
    assert.deepEqual(requestStates(harness), [
      {
        version: 1,
        processing_state: 'RUNNING',
        processing_terminal_reason: undefined,
        effect_knowledge: 'UNKNOWN',
        attempt_ids: [attempts[0]],
      },
      {
        version: 2,
        processing_state: 'FINISHED',
        processing_terminal_reason: 'SUCCEEDED',
        effect_knowledge: 'UNKNOWN',
        attempt_ids: attempts,
      },
    ]);
    const invocations = eventsOfType(harness, 'caller_invocation_started');
    assert.deepEqual(
      invocations.map((event) => ('step_attempt' in event ? [event.step_attempt, event.durable_execution_arn] : [])),
      [
        [1, EXECUTION_ARN],
        [2, EXECUTION_ARN],
      ],
    );
    assert.notEqual(invocations[0]?.source_instance_id, invocations[1]?.source_instance_id, 'one instance per step');
    assert.deepEqual(
      harness.invoker.invocations().map((invocation) => invocation.call.refund_request_id),
      [REFUND_REQUEST_ID, REFUND_REQUEST_ID],
    );
    assert.deepEqual(
      eventsOfType(harness, 'attempt_outcome_recorded').map((event) => event.outcome),
      ['TIMED_OUT', 'SUCCEEDED'],
    );
    assertEventsConform(harness);
  });

  it('records an exhausted inner execution on the first receive and keeps processing RUNNING (AC-RUA-045 feed)', async () => {
    const harness = durableHarness();
    const [first, second] = await exhaustExecution(harness, 1);

    assert.equal(failedAttempt(first).outcome_class, 'AMBIGUOUS');
    assert.equal(failedAttempt(second).step_attempt, 2);
    assert.deepEqual(
      requestStates(harness).map((state) => [
        state.version,
        state.processing_state,
        state.processing_terminal_reason,
        state.effect_knowledge,
      ]),
      [
        [1, 'RUNNING', undefined, 'UNKNOWN'],
        [2, 'RUNNING', undefined, 'UNKNOWN'],
      ],
    );
    const outcomes = eventsOfType(harness, 'attempt_outcome_recorded');
    const [exhausted] = eventsOfType(harness, 'inner_execution_exhausted');
    assert.deepEqual(
      {
        refund: exhausted?.refund_request_id,
        arn: exhausted?.durable_execution_arn,
        steps: exhausted?.step_attempts,
        receive: exhausted?.approximate_receive_count,
        last: exhausted?.last_attempt_id,
        causes: exhausted?.causation_event_ids,
        source: exhausted?.source,
      },
      {
        refund: REFUND_REQUEST_ID,
        arn: EXECUTION_ARN,
        steps: 2,
        receive: 1,
        last: outcomes[1]?.attempt_id,
        causes: [outcomes[1]?.event_id],
        source: 'durable_caller',
      },
    );
    assert.deepEqual(recordTypes(harness).slice(-2), ['request_state_recorded', 'inner_execution_exhausted']);
    assert.deepEqual(eventsOfType(harness, 'inner_execution_exhausted').length, 1);
    assertEventsConform(harness);
  });

  it('finishes RETRIES_EXHAUSTED when the second receive exhausts its execution: four attempts in all (BR-RUA-020)', async () => {
    const harness = durableHarness();
    await exhaustExecution(harness, 1);
    await exhaustExecution(harness, 2);

    assert.equal(harness.invoker.invocations().length, 4);
    assert.deepEqual(
      requestStates(harness).map((state) => [
        state.version,
        state.processing_state,
        state.processing_terminal_reason,
        state.attempt_ids.length,
      ]),
      [
        [1, 'RUNNING', undefined, 1],
        [2, 'RUNNING', undefined, 2],
        [3, 'RUNNING', undefined, 3],
        [4, 'FINISHED', 'RETRIES_EXHAUSTED', 4],
      ],
    );
    assert.deepEqual(
      eventsOfType(harness, 'inner_execution_exhausted').map((event) => event.approximate_receive_count),
      [1, 2],
    );
    assertEventsConform(harness);
  });

  it('decides a receive count beyond the redrive limit as the last receive (clamped to 2)', async () => {
    const harness = durableHarness();
    await exhaustExecution(harness, 3);
    assert.deepEqual(
      requestStates(harness).map((state) => [state.processing_state, state.processing_terminal_reason]),
      [
        ['RUNNING', undefined],
        ['FINISHED', 'RETRIES_EXHAUSTED'],
      ],
    );
  });

  it('keeps an attempt the store proved NOT_DISPATCHED as NOT_ATTEMPTED and retries the step', async () => {
    const harness = durableHarness();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    faultAfterEvent(harness, 'attempt_registered', [DEFINITIVE, DEFINITIVE, DEFINITIVE]);
    const delivery = durableDelivery();

    assert.equal(
      failedAttempt(await failedStep(harness, delivery, invocationOf(1))).outcome_class,
      'PRE_DISPATCH_FAILURE',
    );
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(await runStep(harness, delivery, invocationOf(2)), { terminal_reason: 'SUCCEEDED' });
    assert.deepEqual(
      requestStates(harness).map((state) => [state.processing_state, state.effect_knowledge]),
      [
        ['RUNNING', 'NOT_ATTEMPTED'],
        ['FINISHED', 'ONE_EFFECT_CONFIRMED'],
      ],
    );
    assertEventsConform(harness);
  });

  it('a step attempt after the request finished still calls the provider: no caller-side deduplication', async () => {
    const harness = durableHarness();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    await runStep(harness, durableDelivery(), invocationOf(1));
    await runStep(
      harness,
      durableDelivery({ approximate_receive_count: 2 }),
      invocationOf(1, 'lambda-request-redelivery'),
    );

    assert.equal(harness.invoker.invocations().length, 2);
    assert.deepEqual(
      requestStates(harness).map((state) => [state.processing_state, state.effect_knowledge]),
      [
        ['FINISHED', 'ONE_EFFECT_CONFIRMED'],
        ['FINISHED', 'MULTIPLE_EFFECTS_CONFIRMED'],
      ],
    );
  });
});
