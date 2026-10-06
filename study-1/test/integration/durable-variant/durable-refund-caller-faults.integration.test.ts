// The Durable caller's refusals and faults (BR-RUA-020, BR-RUA-033, BR-RUA-036): a message the
// registration refuses is journaled and completes the step without a provider call; every
// condition under which a step attempt cannot be done with complete evidence throws a
// DurableCallerFault naming the Lambda request, so the step retry strategy and then the source
// decide what follows. No fault makes a provider call the journal does not hold. The faults are
// scripted on the DynamoDB emulator, never on the caller.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  requestStateKey,
  toRequestStateItem,
} from '../../../src/conventional-variant/request-state/request-state-item.ts';
import type { DurableDeployment } from '../../../src/durable-variant/durable-environment.ts';
import { DurableCallerFault, StepAttemptFailed } from '../../../src/durable-variant/durable-fault.ts';
import type { DurableFaultCode } from '../../../src/durable-variant/durable-fault.ts';
import { toTrialRegistryItem } from '../../../src/trial-message/trial-registry.ts';
import { InterleavingItemStore } from '../../support/cleanup/interleaving-item-store.ts';
import { succeededResponder, transportError } from '../../support/provider-client/provider-client-fixtures.ts';
import {
  OTHER_RUN_ID,
  REFUND_REQUEST_ID,
  TRIAL_ID,
  TRIAL_PK,
  VALIDATION,
  VALIDATION_ID,
  messageBody,
  runMessageObject,
  runRegistration,
  validationRegistration,
  withoutFields,
} from '../../unit/trial-message/support/trial-message-fixtures.ts';
import type { DurableHarness } from './support/durable-harness.ts';
import {
  AMBIGUOUS,
  DEFINITIVE,
  TENTH_SECOND_NS,
  assertEventsConform,
  callerEvents,
  durableDelivery,
  durableHarness,
  durableRegistration,
  eventsOfType,
  failedStep,
  faultAfterEvent,
  invocationOf,
  recordTypes,
  requestStates,
  runStep,
} from './support/durable-harness.ts';

const OTHER_RUN_BODY = messageBody(runMessageObject({ run_id: OTHER_RUN_ID }));

async function assertFault(
  harness: DurableHarness,
  code: DurableFaultCode,
  body: string = messageBody(),
  stepAttempt = 1,
): Promise<DurableCallerFault> {
  const thrown = await failedStep(harness, durableDelivery({ body }), invocationOf(stepAttempt));
  assert.ok(thrown instanceof DurableCallerFault, String(thrown));
  assert.equal(thrown.code, code, thrown.message);
  assert.equal(thrown.lambdaRequestId, `lambda-request-step-${String(stepAttempt)}`);
  return thrown;
}

describe('DurableRefundCaller message rejection', () => {
  it('journals a message of another run, finishes MESSAGE_REJECTED and completes the step without a provider call', async () => {
    const harness = durableHarness();
    const delivery = durableDelivery({ body: OTHER_RUN_BODY });

    assert.deepEqual(await runStep(harness, delivery, invocationOf(1)), { terminal_reason: 'MESSAGE_REJECTED' });
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(recordTypes(harness), [
      'caller_invocation_started',
      'trial_message_rejected',
      'request_state_recorded',
    ]);
    const [started] = eventsOfType(harness, 'caller_invocation_started');
    const [rejected] = eventsOfType(harness, 'trial_message_rejected');
    const [state] = eventsOfType(harness, 'request_state_recorded');
    assert.deepEqual(rejected?.causation_event_ids, [started?.event_id]);
    assert.equal(rejected.message_id, delivery.message_id);
    assert.deepEqual(state?.causation_event_ids, [rejected.event_id]);
    assert.deepEqual(
      requestStates(harness).map((recorded) => [
        recorded.processing_state,
        recorded.processing_terminal_reason,
        recorded.effect_knowledge,
      ]),
      [['FINISHED', 'MESSAGE_REJECTED', 'NOT_ATTEMPTED']],
    );
    assertEventsConform(harness);
  });

  it('a body that is no JSON: rejected without a request identity, still MESSAGE_REJECTED', async () => {
    const harness = durableHarness();
    assert.deepEqual(await runStep(harness, durableDelivery({ body: 'not json' }), invocationOf(1)), {
      terminal_reason: 'MESSAGE_REJECTED',
    });
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(recordTypes(harness).slice(0, 2), ['caller_invocation_started', 'trial_message_rejected']);
    assertEventsConform(harness);
  });
});

describe('DurableRefundCaller registry faults', () => {
  it('without an active trial: NO_ACTIVE_TRIAL, nothing journaled', async () => {
    const harness = durableHarness({ registration: null });
    await assertFault(harness, 'NO_ACTIVE_TRIAL');
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
    assert.equal(harness.invoker.invocations().length, 0);
  });

  it('with only the conventional variant registered: NO_ACTIVE_TRIAL for the durable variant', async () => {
    const harness = durableHarness({ registration: runRegistration() });
    await assertFault(harness, 'NO_ACTIVE_TRIAL');
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
  });

  it('a registry read failure: REGISTRY_UNREADABLE', async () => {
    const harness = durableHarness();
    harness.store.scriptReadFault('ProvisionedThroughputExceededException', { table: 'trial_registry' });
    const fault = await assertFault(harness, 'REGISTRY_UNREADABLE');
    assert.match(fault.message, /ProvisionedThroughputExceededException/u);
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
  });

  it('a registry item that is no valid registration: REGISTRY_UNREADABLE', async () => {
    const harness = durableHarness({ registration: null });
    harness.store.seed('trial_registry', { ...toTrialRegistryItem(durableRegistration()), registry_version: 'one' });
    const fault = await assertFault(harness, 'REGISTRY_UNREADABLE');
    assert.match(fault.message, /REGISTRATION_INVALID/u);
  });

  it('a registration of another run than the deployed one: REGISTRATION_MISMATCH', async () => {
    const harness = durableHarness({ registration: durableRegistration({ run_id: OTHER_RUN_ID }) });
    const fault = await assertFault(harness, 'REGISTRATION_MISMATCH', OTHER_RUN_BODY);
    assert.match(fault.message, new RegExp(`run_id ${OTHER_RUN_ID}; expected the deployed run_id`, 'u'));
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
  });

  it('a variant validation trial runs under a validation deployment, in its own partition', async () => {
    const harness = durableHarness({
      deployment: VALIDATION as DurableDeployment,
      registration: { ...validationRegistration(), variant_id: 'durable' },
    });
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    const body = messageBody({ ...withoutFields(runMessageObject(), 'run_id'), variant_validation_id: VALIDATION_ID });

    assert.deepEqual(await runStep(harness, durableDelivery({ body }), invocationOf(1)), {
      terminal_reason: 'SUCCEEDED',
    });
    const partitions = new Set(harness.store.itemsIn('caller_journal').map((item) => item.pk));
    assert.deepEqual([...partitions], [`${VALIDATION_ID}#${TRIAL_ID}`]);
    assert.equal(harness.invoker.invocations()[0]?.call.variant_validation_id, VALIDATION_ID);
  });

  it('a run registration under a validation deployment: REGISTRATION_MISMATCH naming the validation id', async () => {
    const harness = durableHarness({ deployment: VALIDATION as DurableDeployment });
    const fault = await assertFault(harness, 'REGISTRATION_MISMATCH');
    assert.match(fault.message, new RegExp(`expected the deployed variant_validation_id ${VALIDATION_ID}`, 'u'));
  });
});

describe('DurableRefundCaller journal and state faults', () => {
  it('an ambiguous write of the invocation start: JOURNAL_STOPPED, no provider call', async () => {
    const harness = durableHarness();
    harness.store.scriptWriteFault(AMBIGUOUS, { table: 'caller_journal' });
    const fault = await assertFault(harness, 'JOURNAL_STOPPED');
    assert.match(fault.message, /^JOURNAL_STOPPED: caller_invocation_started not written: /u);
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(callerEvents(harness), []);
  });

  it('a damaged request-state item: STATE_NOT_RECORDED before any provider call', async () => {
    const harness = durableHarness();
    harness.store.seed('caller_journal', { pk: TRIAL_PK, sk: `state#request#${REFUND_REQUEST_ID}`, version: 'one' });
    const fault = await assertFault(harness, 'STATE_NOT_RECORDED');
    assert.match(fault.message, /the orphan reconciliation not recorded/u);
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(recordTypes(harness), ['caller_invocation_started']);
  });

  it('a damaged request-state item on a rejected message: STATE_NOT_RECORDED after the rejection is journaled', async () => {
    const harness = durableHarness();
    harness.store.seed('caller_journal', { pk: TRIAL_PK, sk: `state#request#${REFUND_REQUEST_ID}`, version: 0 });
    const fault = await assertFault(harness, 'STATE_NOT_RECORDED', OTHER_RUN_BODY);
    assert.match(fault.message, /MESSAGE_REJECTED not recorded/u);
    assert.deepEqual(recordTypes(harness), ['caller_invocation_started', 'trial_message_rejected']);
  });

  it('an ambiguous write of the rejection event: JOURNAL_STOPPED, no state recorded', async () => {
    const harness = durableHarness();
    faultAfterEvent(harness, 'caller_invocation_started', [AMBIGUOUS]);
    const fault = await assertFault(harness, 'JOURNAL_STOPPED', OTHER_RUN_BODY);
    assert.match(fault.message, /trial_message_rejected not written/u);
    assert.deepEqual(requestStates(harness), []);
  });

  it('a provider qualifier the shared client refuses: its RangeError propagates unmapped, nothing registered', async () => {
    const harness = durableHarness({ providerQualifier: '$LATEST' });
    const thrown = await failedStep(harness, durableDelivery(), invocationOf(1));
    assert.ok(thrown instanceof RangeError, String(thrown));
    assert.match(thrown.message, /provider_qualifier "\$LATEST"/u);
    assert.deepEqual(eventsOfType(harness, 'attempt_registered'), []);
    assert.equal(harness.invoker.invocations().length, 0);
  });

  it('a registration the store refuses three times: ATTEMPT_NOT_REGISTERED, no provider call', async () => {
    const harness = durableHarness();
    faultAfterEvent(harness, 'caller_invocation_started', [DEFINITIVE, DEFINITIVE, DEFINITIVE]);
    await assertFault(harness, 'ATTEMPT_NOT_REGISTERED');
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(requestStates(harness), []);
  });

  it('a lost outcome write: JOURNAL_STOPPED, and the next step attempt folds the dispatched orphan in as UNKNOWN', async () => {
    const harness = durableHarness();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    faultAfterEvent(harness, 'dispatch_started', [AMBIGUOUS]);
    const fault = await assertFault(harness, 'JOURNAL_STOPPED');
    assert.match(fault.message, /without its attempt_outcome_recorded event/u);
    assert.deepEqual(requestStates(harness), []);
    const [orphan] = eventsOfType(harness, 'attempt_registered');

    assert.deepEqual(await runStep(harness, durableDelivery(), invocationOf(2)), { terminal_reason: 'SUCCEEDED' });
    const attempts = eventsOfType(harness, 'attempt_registered').map((event) => event.attempt_id);
    assert.deepEqual(requestStates(harness), [
      {
        version: 1,
        processing_state: 'RUNNING',
        processing_terminal_reason: undefined,
        effect_knowledge: 'UNKNOWN',
        attempt_ids: [orphan?.attempt_id],
      },
      {
        version: 2,
        processing_state: 'FINISHED',
        processing_terminal_reason: 'SUCCEEDED',
        effect_knowledge: 'UNKNOWN',
        attempt_ids: attempts,
      },
    ]);
    const [, secondStart] = eventsOfType(harness, 'caller_invocation_started');
    const [reconciled] = eventsOfType(harness, 'request_state_recorded');
    assert.deepEqual(reconciled?.causation_event_ids, [secondStart?.event_id]);
    assertEventsConform(harness);
  });

  it('a lost state write after a success: STATE_NOT_RECORDED, then the next step attempt folds the orphan in', async () => {
    const harness = durableHarness();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    faultAfterEvent(harness, 'attempt_outcome_recorded', [DEFINITIVE, DEFINITIVE, DEFINITIVE]);
    const fault = await assertFault(harness, 'STATE_NOT_RECORDED');
    assert.match(fault.message, /the state after attempt [0-9a-f-]{36} not recorded/u);
    assert.deepEqual(await runStep(harness, durableDelivery(), invocationOf(2)), { terminal_reason: 'SUCCEEDED' });
    assert.deepEqual(
      requestStates(harness).map((state) => [state.version, state.processing_state, state.effect_knowledge]),
      [
        [1, 'RUNNING', 'ONE_EFFECT_CONFIRMED'],
        [2, 'FINISHED', 'MULTIPLE_EFFECTS_CONFIRMED'],
      ],
    );
    assertEventsConform(harness);
  });

  it('an inner_execution_exhausted the journal cannot write: JOURNAL_STOPPED after the state is recorded', async () => {
    const harness = durableHarness();
    const answer = (): ReturnType<typeof transportError> => transportError('ServiceException', 'Service failure', 500);
    harness.invoker.resolveAfter(TENTH_SECOND_NS, answer);
    harness.invoker.resolveAfter(TENTH_SECOND_NS, answer);
    const thrown = await failedStep(harness, durableDelivery(), invocationOf(1));
    assert.ok(thrown instanceof StepAttemptFailed, String(thrown));
    faultAfterEvent(harness, 'request_state_recorded', [AMBIGUOUS]);
    const fault = await assertFault(harness, 'JOURNAL_STOPPED', messageBody(), 2);
    assert.match(fault.message, /^JOURNAL_STOPPED: inner_execution_exhausted not written: /u);
    assert.deepEqual(
      requestStates(harness).map((state) => state.processing_state),
      ['RUNNING', 'RUNNING'],
    );
    assert.deepEqual(eventsOfType(harness, 'inner_execution_exhausted'), []);
  });

  it('a request state written by another writer between read and write: STATE_NOT_RECORDED (VERSION_CONFLICT)', async () => {
    const harness = durableHarness({
      wrapStore: (store) => {
        const racing = new InterleavingItemStore(store);
        racing.afterRead(3, async (inner) => {
          const key = requestStateKey(TRIAL_PK, { refund_request_id: REFUND_REQUEST_ID });
          const snapshot = {
            version: 1,
            effect_knowledge: 'UNKNOWN',
            attempt_ids: [],
            processing_state: 'RUNNING',
          } as const;
          await inner.write({ kind: 'put', table: 'caller_journal', item: toRequestStateItem(key, snapshot) });
        });
        return racing;
      },
    });
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    const fault = await assertFault(harness, 'STATE_NOT_RECORDED');
    assert.match(fault.message, /changed since version 0 was read/u);
    assert.deepEqual(eventsOfType(harness, 'request_state_recorded'), []);
  });
});
