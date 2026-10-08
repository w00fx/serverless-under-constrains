// The conventional variant end to end offline (BR-RUA-020, BR-RUA-024, BR-RUA-004, BR-RUA-033;
// AC-RUA-003 and AC-RUA-045 feed): the FIFO source and its DLQ, the event source mapping, the
// consumer, the shared provider client and the caller journal, on virtual time. Expected states
// come from the spec: a control trial finishes SUCCEEDED with one confirmed effect; a timeout
// keeps processing RUNNING with knowledge UNKNOWN until the redelivery, and UNKNOWN is absorbing.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProviderRefundCall } from '../../../src/record-contract/records/group-a/provider_refund_call.ts';
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
import {
  assertEventsConform,
  callerEvents,
  conventionalHarness,
  eventsOfType,
  poll,
  publish,
  requestStates,
  waitOutVisibility,
} from './support/conventional-harness.ts';

const ONE_SECOND_NS = 1_000_000_000n;

function invocationsOf(calls: readonly { readonly call: ProviderRefundCall }[]): readonly ProviderRefundCall[] {
  return calls.map((invocation) => invocation.call);
}

describe('ConventionalRefundConsumer through the FIFO source', () => {
  it('completes a control delivery: one attempt, SUCCEEDED, one confirmed effect, message deleted', async () => {
    const harness = conventionalHarness();
    harness.invoker.resolveAfter(ONE_SECOND_NS / 10n, succeededResponder);
    const messageId = publish(harness);

    assert.deepEqual(await poll(harness), { kind: 'completed', message_id: messageId, receive_count: 1 });
    assert.deepEqual(
      callerEvents(harness).map((event) => event.record_type),
      [
        'caller_invocation_started',
        'attempt_registered',
        'dispatch_started',
        'attempt_outcome_recorded',
        'request_state_recorded',
      ],
    );
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
        source: 'conventional_caller',
        source_instance_id: undefined,
        source_sequence: 1,
        lambda_request_id: 'lambda-request-0001',
        message_id: messageId,
        approximate_receive_count: 1,
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
        refund_request_id: REFUND_REQUEST_ID,
      },
    ]);
    const [call] = invocationsOf(harness.invoker.invocations());
    assert.deepEqual(
      { caller: call?.caller_id, run: call?.run_id, trial: call?.trial_id, digest: call?.trial_manifest_sha256 },
      { caller: 'conventional', run: RUN_ID, trial: TRIAL_ID, digest: TRIAL_MANIFEST_SHA },
    );
    assert.deepEqual(
      {
        refund: call?.refund_request_id,
        payment: call?.payment_id,
        amount: call?.amount_minor,
        currency: call?.currency,
      },
      { refund: REFUND_REQUEST_ID, payment: PAYMENT_ID, amount: 10000, currency: 'BRL' },
    );
    assert.deepEqual(harness.source.messages(), []);
    assert.deepEqual(harness.dlq.messages(), []);
    assertEventsConform(harness);
  });

  it('redelivers after a timeout: RUNNING and UNKNOWN, then SUCCEEDED with UNKNOWN kept (AC-RUA-003)', async () => {
    const harness = conventionalHarness();
    harness.invoker.hang();
    harness.invoker.resolveAfter(ONE_SECOND_NS / 10n, succeededResponder);
    const messageId = publish(harness);

    const first = await poll(harness);
    assert.equal(first.kind, 'failed');
    assert.equal((first.error as Error).name, 'DeliveryFailurePropagated');
    assert.deepEqual(await poll(harness), { kind: 'empty' }, 'the message stays invisible until the timeout expires');
    await waitOutVisibility(harness);
    assert.deepEqual(await poll(harness), { kind: 'completed', message_id: messageId, receive_count: 2 });

    const attempts = eventsOfType(harness, 'attempt_registered').map((event) => event.attempt_id);
    assert.equal(attempts.length, 2);
    assert.deepEqual(requestStates(harness), [
      {
        version: 1,
        processing_state: 'RUNNING',
        processing_terminal_reason: undefined,
        effect_knowledge: 'UNKNOWN',
        attempt_ids: [attempts[0]],
        refund_request_id: REFUND_REQUEST_ID,
      },
      {
        version: 2,
        processing_state: 'FINISHED',
        processing_terminal_reason: 'SUCCEEDED',
        effect_knowledge: 'UNKNOWN',
        attempt_ids: attempts,
        refund_request_id: REFUND_REQUEST_ID,
      },
    ]);
    const invocations = eventsOfType(harness, 'caller_invocation_started');
    assert.deepEqual(
      invocations.map((event) => ('approximate_receive_count' in event ? event.approximate_receive_count : 0)),
      [1, 2],
    );
    assert.notEqual(
      invocations[0]?.source_instance_id,
      invocations[1]?.source_instance_id,
      'one source instance per invocation',
    );
    assert.deepEqual(
      invocationsOf(harness.invoker.invocations()).map((call) => call.refund_request_id),
      [REFUND_REQUEST_ID, REFUND_REQUEST_ID],
    );
    assert.deepEqual(
      eventsOfType(harness, 'attempt_outcome_recorded').map((event) => event.outcome),
      ['TIMED_OUT', 'SUCCEEDED'],
    );
    assert.deepEqual(harness.dlq.messages(), []);
    assertEventsConform(harness);
  });

  it('exhausts retries after two ambiguous deliveries, and the redrive moves the message to the DLQ', async () => {
    const harness = conventionalHarness();
    harness.invoker.hang();
    harness.invoker.hang();
    const messageId = publish(harness);

    assert.equal((await poll(harness)).kind, 'failed');
    await waitOutVisibility(harness);
    assert.equal((await poll(harness)).kind, 'failed');
    await waitOutVisibility(harness);
    assert.deepEqual(await poll(harness), { kind: 'empty' });

    assert.deepEqual(
      requestStates(harness).map((state) => [
        state.version,
        state.processing_state,
        state.processing_terminal_reason,
        state.effect_knowledge,
      ]),
      [
        [1, 'RUNNING', undefined, 'UNKNOWN'],
        [2, 'FINISHED', 'RETRIES_EXHAUSTED', 'UNKNOWN'],
      ],
    );
    assert.equal(harness.invoker.invocations().length, 2);
    assert.deepEqual(
      harness.dlq.messages().map((message) => [message.message_id, message.receive_count]),
      [[messageId, 2]],
    );
    assert.deepEqual(harness.source.messages(), []);
    assertEventsConform(harness);
  });

  it('finishes RETRIES_EXHAUSTED on the first invocation when a throttle consumed the first receive (RK-08)', async () => {
    const harness = conventionalHarness();
    harness.invoker.hang();
    publish(harness);
    harness.driver.throttleNext();

    assert.equal((await poll(harness)).kind, 'throttled');
    await waitOutVisibility(harness);
    const invoked = await poll(harness);
    assert.equal(invoked.kind === 'failed' ? invoked.receive_count : 0, 2);
    assert.deepEqual(
      requestStates(harness).map((state) => [state.processing_state, state.processing_terminal_reason]),
      [['FINISHED', 'RETRIES_EXHAUSTED']],
    );
    const [started] = eventsOfType(harness, 'caller_invocation_started');
    assert.equal(
      started !== undefined && 'approximate_receive_count' in started ? started.approximate_receive_count : 0,
      2,
    );
  });

  it('completes a provider rejection as PROVIDER_REJECTED with no effect confirmed', async () => {
    const harness = conventionalHarness();
    harness.invoker.resolveAfter(ONE_SECOND_NS / 10n, rejectedResponder('AUTHORIZATION_FAILED'));
    publish(harness);

    assert.equal((await poll(harness)).kind, 'completed');
    assert.deepEqual(
      requestStates(harness).map((state) => [
        state.processing_state,
        state.processing_terminal_reason,
        state.effect_knowledge,
      ]),
      [['FINISHED', 'PROVIDER_REJECTED', 'NO_EFFECT_CONFIRMED']],
    );
    assertEventsConform(harness);
  });

  it('propagates a dispatched transport failure as ambiguous, keeping knowledge UNKNOWN', async () => {
    const harness = conventionalHarness();
    harness.invoker.resolveAfter(ONE_SECOND_NS / 10n, () =>
      transportError('TooManyRequestsException', 'Rate exceeded', 429),
    );
    publish(harness);

    assert.equal((await poll(harness)).kind, 'failed');
    assert.deepEqual(
      requestStates(harness).map((state) => [state.processing_state, state.effect_knowledge]),
      [['RUNNING', 'UNKNOWN']],
    );
  });

  it('accepts a duplicate publication within the deduplication interval without a second delivery', async () => {
    const harness = conventionalHarness();
    harness.invoker.resolveAfter(ONE_SECOND_NS / 10n, succeededResponder);
    const first = publish(harness);
    assert.equal(publish(harness), first);
    assert.equal((await poll(harness)).kind, 'completed');
    assert.deepEqual(await poll(harness), { kind: 'empty' });
    assert.equal(harness.invoker.invocations().length, 1);
  });

  it('records the trial partition only: no item outside the run trial partition', async () => {
    const harness = conventionalHarness();
    harness.invoker.resolveAfter(ONE_SECOND_NS / 10n, succeededResponder);
    publish(harness);
    await poll(harness);
    assert.deepEqual([...new Set(harness.store.itemsIn('caller_journal').map((item) => item.pk))], [TRIAL_PK]);
    assert.deepEqual(
      harness.store
        .itemsIn('caller_journal')
        .filter((item) => item.sk.startsWith('state#'))
        .map((item) => item.sk.replace(/[0-9a-f-]{36}$/u, '<id>')),
      ['state#attempt#<id>', 'state#request#ref-poc-001'],
    );
  });
});
