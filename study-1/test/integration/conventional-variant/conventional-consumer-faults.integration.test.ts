// The conventional caller's faults (BR-RUA-020, BR-RUA-033): every condition under which the
// caller cannot do its work with complete evidence throws a ConventionalCallerFault, so the
// event source mapping keeps the message and SQS redelivers it until the redrive policy moves it
// to the DLQ. No fault ever completes a delivery, and no fault makes a provider call the journal
// does not hold. The faults are scripted on the DynamoDB emulator, never on the consumer.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConventionalCallerFault } from '../../../src/conventional-variant/conventional-fault.ts';
import type { ConventionalFaultCode } from '../../../src/conventional-variant/conventional-fault.ts';
import type { VariantDeployment } from '../../../src/conventional-variant/conventional-environment.ts';
import {
  requestStateKey,
  toRequestStateItem,
} from '../../../src/conventional-variant/request-state/request-state-item.ts';
import { consumeSqsEvent } from '../../../src/conventional-variant/sqs-event-consumption.ts';
import { toTrialRegistryItem } from '../../../src/trial-message/trial-registry.ts';
import type { PollResult } from '../../support/fifo-queue/fake-sqs-esm-driver.ts';
import type { ScriptedWriteFault } from '../../support/durable-store/in-memory-item-store.ts';
import { InterleavingItemStore } from '../../support/cleanup/interleaving-item-store.ts';
import { succeededResponder } from '../../support/provider-client/provider-client-fixtures.ts';
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
import type { ConventionalHarness } from './support/conventional-harness.ts';
import {
  assertEventsConform,
  callerEvents,
  conventionalHarness,
  eventsOfType,
  poll,
  publish,
  requestStates,
  settle,
  waitOutVisibility,
} from './support/conventional-harness.ts';

const TENTH_SECOND_NS = 100_000_000n;
const DEFINITIVE: ScriptedWriteFault = { kind: 'definitive_failure', code: 'ValidationException' };
const AMBIGUOUS: ScriptedWriteFault = { kind: 'ambiguous', code: 'TimeoutError', applied: false };

function faultOf(result: PollResult): ConventionalFaultCode | undefined {
  if (result.kind !== 'failed') {
    return undefined;
  }
  return result.error instanceof ConventionalCallerFault ? result.error.code : undefined;
}

async function assertFault(harness: ConventionalHarness, code: ConventionalFaultCode): Promise<void> {
  const result = await poll(harness);
  assert.equal(faultOf(result), code, result.kind === 'failed' ? String(result.error) : result.kind);
}

/** Scripts `faults` on the next caller-journal writes once an event of `recordType` is committed. */
function faultAfterEvent(
  harness: ConventionalHarness,
  recordType: string,
  faults: readonly ScriptedWriteFault[],
): void {
  const stop = harness.store.subscribe('caller_journal', (change) => {
    if (change.new_image['record_type'] !== recordType) {
      return;
    }
    stop();
    for (const fault of faults) {
      harness.store.scriptWriteFault(fault, { table: 'caller_journal' });
    }
  });
}

describe('ConventionalRefundConsumer registry faults', () => {
  it('without an active trial: NO_ACTIVE_TRIAL, nothing journaled, then the redrive moves the message to the DLQ', async () => {
    const harness = conventionalHarness({ registration: null });
    const messageId = publish(harness);
    await assertFault(harness, 'NO_ACTIVE_TRIAL');
    await waitOutVisibility(harness);
    await assertFault(harness, 'NO_ACTIVE_TRIAL');
    await waitOutVisibility(harness);
    assert.deepEqual(await poll(harness), { kind: 'empty' });
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(
      harness.dlq.messages().map((message) => [message.message_id, message.receive_count]),
      [[messageId, 2]],
    );
  });

  it('a registry read failure: REGISTRY_UNREADABLE', async () => {
    const harness = conventionalHarness();
    harness.store.scriptReadFault('ProvisionedThroughputExceededException', { table: 'trial_registry' });
    publish(harness);
    await assertFault(harness, 'REGISTRY_UNREADABLE');
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
  });

  it('a registry item that is no valid registration of this variant: REGISTRY_UNREADABLE', async () => {
    const harness = conventionalHarness({ registration: null });
    harness.store.seed('trial_registry', { ...toTrialRegistryItem(runRegistration()), registry_version: 'one' });
    publish(harness);
    const result = await poll(harness);
    assert.equal(faultOf(result), 'REGISTRY_UNREADABLE');
    assert.match(String(result.kind === 'failed' ? result.error : ''), /REGISTRATION_INVALID/u);
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
  });

  it('a registration of another run than the deployed one: REGISTRATION_MISMATCH', async () => {
    const harness = conventionalHarness({ registration: runRegistration({ run_id: OTHER_RUN_ID }) });
    publish(harness, messageBody(runMessageObject({ run_id: OTHER_RUN_ID })));
    const result = await poll(harness);
    assert.equal(faultOf(result), 'REGISTRATION_MISMATCH');
    assert.match(String(result.kind === 'failed' ? result.error : ''), new RegExp(OTHER_RUN_ID, 'u'));
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
  });

  it('a variant validation trial runs under a validation deployment, in its own partition', async () => {
    const harness = conventionalHarness({
      deployment: VALIDATION as VariantDeployment,
      registration: validationRegistration(),
    });
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    const body = messageBody({ ...withoutFields(runMessageObject(), 'run_id'), variant_validation_id: VALIDATION_ID });
    publish(harness, body);
    assert.equal((await poll(harness)).kind, 'completed');
    const partitions = new Set(harness.store.itemsIn('caller_journal').map((item) => item.pk));
    assert.deepEqual([...partitions], [`${VALIDATION_ID}#${TRIAL_ID}`]);
    assert.equal(harness.invoker.invocations()[0]?.call.variant_validation_id, VALIDATION_ID);
  });
});

describe('ConventionalRefundConsumer journal and state faults', () => {
  it('an event that is no single SQS delivery: DELIVERY_INVALID before any read', async () => {
    const harness = conventionalHarness();
    await assert.rejects(
      settle(harness, consumeSqsEvent(harness.consumer, { Records: [] }, 'lambda-request-x')),
      (error: unknown) => error instanceof ConventionalCallerFault && error.code === 'DELIVERY_INVALID',
    );
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
  });

  it('an ambiguous write of the invocation start: JOURNAL_STOPPED, no provider call', async () => {
    const harness = conventionalHarness();
    harness.store.scriptWriteFault(AMBIGUOUS, { table: 'caller_journal' });
    publish(harness);
    await assertFault(harness, 'JOURNAL_STOPPED');
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(callerEvents(harness), []);
  });

  it('a damaged request-state item: STATE_NOT_RECORDED before any provider call', async () => {
    const harness = conventionalHarness();
    harness.store.seed('caller_journal', {
      pk: TRIAL_PK,
      sk: `state#request#${REFUND_REQUEST_ID}`,
      version: 'one',
    });
    publish(harness);
    await assertFault(harness, 'STATE_NOT_RECORDED');
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(
      callerEvents(harness).map((event) => event.record_type),
      ['caller_invocation_started'],
    );
  });

  it('a damaged request-state item on a rejected message: STATE_NOT_RECORDED after the rejection is journaled', async () => {
    const harness = conventionalHarness();
    harness.store.seed('caller_journal', { pk: TRIAL_PK, sk: `state#request#${REFUND_REQUEST_ID}`, version: 0 });
    publish(harness, messageBody(runMessageObject({ run_id: OTHER_RUN_ID })));
    await assertFault(harness, 'STATE_NOT_RECORDED');
    assert.deepEqual(
      callerEvents(harness).map((event) => event.record_type),
      ['caller_invocation_started', 'trial_message_rejected'],
    );
  });

  it('an ambiguous write of the rejection event: JOURNAL_STOPPED, no state recorded', async () => {
    const harness = conventionalHarness();
    faultAfterEvent(harness, 'caller_invocation_started', [AMBIGUOUS]);
    publish(harness, messageBody(runMessageObject({ run_id: OTHER_RUN_ID })));
    await assertFault(harness, 'JOURNAL_STOPPED');
    assert.deepEqual(requestStates(harness), []);
  });

  it('a provider qualifier the shared client refuses: its RangeError propagates unmapped, nothing registered', async () => {
    const harness = conventionalHarness({ providerQualifier: '$LATEST' });
    publish(harness);
    const result = await poll(harness);
    assert.equal(result.kind, 'failed');
    const { error } = result;
    assert.ok(error instanceof RangeError, String(error));
    assert.match(error.message, /provider_qualifier "\$LATEST"/u);
    assert.deepEqual(eventsOfType(harness, 'attempt_registered'), []);
    assert.equal(harness.invoker.invocations().length, 0);
  });

  it('a registration the store refuses three times: ATTEMPT_NOT_REGISTERED, no provider call', async () => {
    const harness = conventionalHarness();
    faultAfterEvent(harness, 'caller_invocation_started', [DEFINITIVE, DEFINITIVE, DEFINITIVE]);
    publish(harness);
    await assertFault(harness, 'ATTEMPT_NOT_REGISTERED');
    assert.equal(harness.invoker.invocations().length, 0);
    assert.deepEqual(requestStates(harness), []);
  });

  it('a lost outcome write: JOURNAL_STOPPED, and the next delivery folds the dispatched orphan in as UNKNOWN', async () => {
    const harness = conventionalHarness();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    faultAfterEvent(harness, 'dispatch_started', [AMBIGUOUS]);
    publish(harness);
    await assertFault(harness, 'JOURNAL_STOPPED');
    assert.deepEqual(requestStates(harness), []);
    const [orphan] = eventsOfType(harness, 'attempt_registered');

    await waitOutVisibility(harness);
    assert.equal((await poll(harness)).kind, 'completed');
    const attempts = eventsOfType(harness, 'attempt_registered').map((event) => event.attempt_id);
    assert.deepEqual(requestStates(harness), [
      {
        version: 1,
        processing_state: 'RUNNING',
        processing_terminal_reason: undefined,
        effect_knowledge: 'UNKNOWN',
        attempt_ids: [orphan?.attempt_id],
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
    const [, secondStart] = eventsOfType(harness, 'caller_invocation_started');
    const [reconciled] = eventsOfType(harness, 'request_state_recorded');
    assert.deepEqual(reconciled?.causation_event_ids, [secondStart?.event_id]);
    assertEventsConform(harness);
  });

  it('a lost state write after a success: the next delivery folds the orphan in from its outcome, then a second effect', async () => {
    const harness = conventionalHarness();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    faultAfterEvent(harness, 'attempt_outcome_recorded', [DEFINITIVE, DEFINITIVE, DEFINITIVE]);
    publish(harness);
    await assertFault(harness, 'STATE_NOT_RECORDED');
    await waitOutVisibility(harness);
    assert.equal((await poll(harness)).kind, 'completed');
    assert.deepEqual(
      requestStates(harness).map((state) => [state.version, state.processing_state, state.effect_knowledge]),
      [
        [1, 'RUNNING', 'ONE_EFFECT_CONFIRMED'],
        [2, 'FINISHED', 'MULTIPLE_EFFECTS_CONFIRMED'],
      ],
    );
    assertEventsConform(harness);
  });

  it('an ambiguous dispatch transition: the orphan in PRE_DISPATCH is folded in as UNKNOWN, conservatively', async () => {
    const harness = conventionalHarness();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    faultAfterEvent(harness, 'attempt_registered', [AMBIGUOUS]);
    publish(harness);
    await assertFault(harness, 'JOURNAL_STOPPED');
    assert.equal(harness.invoker.invocations().length, 0);
    await waitOutVisibility(harness);
    assert.equal((await poll(harness)).kind, 'completed');
    assert.deepEqual(
      requestStates(harness).map((state) => [
        state.version,
        state.processing_state,
        state.effect_knowledge,
        state.attempt_ids.length,
      ]),
      [
        [1, 'RUNNING', 'UNKNOWN', 1],
        [2, 'FINISHED', 'UNKNOWN', 2],
      ],
    );
    assertEventsConform(harness);
  });

  it('an attempt proven NOT_DISPATCHED whose outcome was lost is folded in as NOT_ATTEMPTED', async () => {
    const harness = conventionalHarness();
    harness.invoker.resolveAfter(TENTH_SECOND_NS, succeededResponder);
    faultAfterEvent(harness, 'attempt_registered', [DEFINITIVE, DEFINITIVE, DEFINITIVE]);
    faultAfterEvent(harness, 'attempt_not_dispatched', [AMBIGUOUS]);
    publish(harness);
    await assertFault(harness, 'JOURNAL_STOPPED');
    assert.equal(harness.invoker.invocations().length, 0);
    await waitOutVisibility(harness);
    assert.equal((await poll(harness)).kind, 'completed');
    assert.deepEqual(
      requestStates(harness).map((state) => [
        state.version,
        state.processing_state,
        state.effect_knowledge,
        state.attempt_ids.length,
      ]),
      [
        [1, 'RUNNING', 'NOT_ATTEMPTED', 1],
        [2, 'FINISHED', 'ONE_EFFECT_CONFIRMED', 2],
      ],
    );
    assertEventsConform(harness);
  });

  it('a request state written by another writer between read and write: STATE_NOT_RECORDED (VERSION_CONFLICT)', async () => {
    const harness = conventionalHarness({
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
    publish(harness);
    const result = await poll(harness);
    assert.equal(faultOf(result), 'STATE_NOT_RECORDED');
    assert.match(String(result.kind === 'failed' ? result.error : ''), /changed since version 0 was read/u);
    assert.deepEqual(eventsOfType(harness, 'request_state_recorded'), []);
  });
});
