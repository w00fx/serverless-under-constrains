// AC-RUA-019 (integration; cases: wrong execution identity, wrong trial-manifest digest): a
// published message whose execution identity or trial-manifest digest does not match the active
// frozen trial is rejected by the consumer, which records MESSAGE_REJECTED, makes no provider
// call, and leaves effect knowledge NOT_ATTEMPTED. The delivery completes, so SQS never delivers
// the rejected message again. The other closed reasons (BR-RUA-036) are journaled the same way.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256Hex } from '../../../src/record-contract/digests.ts';
import {
  OTHER_RUN_ID,
  OTHER_TRIAL_MANIFEST_SHA,
  PAYMENT_ID,
  REFUND_REQUEST_ID,
  RUN_ID,
  TRIAL_MANIFEST_SHA,
  messageBody,
  runMessageObject,
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
} from './support/conventional-harness.ts';

async function rejectOnce(
  body: string,
): Promise<{ readonly harness: ConventionalHarness; readonly messageId: string }> {
  const harness = conventionalHarness();
  const messageId = publish(harness, body);
  assert.deepEqual(await poll(harness), { kind: 'completed', message_id: messageId, receive_count: 1 });
  return { harness, messageId };
}

function rejectedEvent(harness: ConventionalHarness): Readonly<Record<string, unknown>> {
  const [rejected] = eventsOfType(harness, 'trial_message_rejected');
  assert.ok(rejected !== undefined, 'trial_message_rejected is journaled');
  return rejected as unknown as Readonly<Record<string, unknown>>;
}

function assertNoProviderCall(harness: ConventionalHarness): void {
  assert.equal(harness.invoker.invocations().length, 0);
  assert.deepEqual(eventsOfType(harness, 'attempt_registered'), []);
}

describe('AC-RUA-019 consumer manifest mismatch', () => {
  it('wrong execution identity: MESSAGE_REJECTED, no provider call, knowledge NOT_ATTEMPTED', async () => {
    const body = messageBody(runMessageObject({ run_id: OTHER_RUN_ID }));
    const { harness, messageId } = await rejectOnce(body);

    assertNoProviderCall(harness);
    const rejected = rejectedEvent(harness);
    const [started] = eventsOfType(harness, 'caller_invocation_started');
    assert.deepEqual(
      {
        reason: rejected['reason'],
        offending: rejected['offending_value'],
        expected: rejected['expected_value'],
        message_id: rejected['message_id'],
        digest: rejected['message_body_sha256'],
        refund: rejected['refund_request_id'],
        payment: rejected['payment_id'],
        causation: rejected['causation_event_ids'],
      },
      {
        reason: 'EXECUTION_IDENTITY_MISMATCH',
        offending: OTHER_RUN_ID,
        expected: RUN_ID,
        message_id: messageId,
        digest: sha256Hex(new TextEncoder().encode(body)),
        refund: REFUND_REQUEST_ID,
        payment: PAYMENT_ID,
        causation: [started?.event_id],
      },
    );
    assert.deepEqual(requestStates(harness), [
      {
        version: 1,
        processing_state: 'FINISHED',
        processing_terminal_reason: 'MESSAGE_REJECTED',
        effect_knowledge: 'NOT_ATTEMPTED',
        attempt_ids: [],
        refund_request_id: REFUND_REQUEST_ID,
      },
    ]);
    const [state] = eventsOfType(harness, 'request_state_recorded');
    assert.deepEqual(state?.causation_event_ids, [rejected['event_id']]);
    assert.deepEqual(harness.source.messages(), [], 'the rejected message is deleted, never redelivered');
    assert.deepEqual(harness.dlq.messages(), []);
    assertEventsConform(harness);
  });

  it('wrong trial-manifest digest: MESSAGE_REJECTED, no provider call, knowledge NOT_ATTEMPTED', async () => {
    const { harness } = await rejectOnce(
      messageBody(runMessageObject({ trial_manifest_sha256: OTHER_TRIAL_MANIFEST_SHA })),
    );

    assertNoProviderCall(harness);
    const rejected = rejectedEvent(harness);
    assert.deepEqual(
      [rejected['reason'], rejected['offending_value'], rejected['expected_value']],
      ['TRIAL_MANIFEST_DIGEST_MISMATCH', OTHER_TRIAL_MANIFEST_SHA, TRIAL_MANIFEST_SHA],
    );
    assert.deepEqual(
      requestStates(harness).map((state) => [
        state.processing_terminal_reason,
        state.effect_knowledge,
        state.attempt_ids,
      ]),
      [['MESSAGE_REJECTED', 'NOT_ATTEMPTED', []]],
    );
    assertEventsConform(harness);
  });

  it('a message without its correlation fields: CORRELATION_MISSING, keyed by its readable request', async () => {
    const { harness } = await rejectOnce(messageBody(withoutFields(runMessageObject(), 'trial_id')));
    assertNoProviderCall(harness);
    assert.equal(rejectedEvent(harness)['reason'], 'CORRELATION_MISSING');
    assert.deepEqual(
      requestStates(harness).map((state) => [state.processing_terminal_reason, state.refund_request_id]),
      [['MESSAGE_REJECTED', REFUND_REQUEST_ID]],
    );
    assertEventsConform(harness);
  });

  it('a body that is not JSON: SCHEMA_INVALID, its state keyed by the message id', async () => {
    const { harness, messageId } = await rejectOnce('not a trial message');
    assertNoProviderCall(harness);
    const rejected = rejectedEvent(harness);
    assert.equal(rejected['reason'], 'SCHEMA_INVALID');
    assert.equal(rejected['refund_request_id'], undefined);
    assert.deepEqual(requestStates(harness), [
      {
        version: 1,
        processing_state: 'FINISHED',
        processing_terminal_reason: 'MESSAGE_REJECTED',
        effect_knowledge: 'NOT_ATTEMPTED',
        attempt_ids: [],
        refund_request_id: undefined,
      },
    ]);
    assert.ok(
      harness.store.peek('caller_journal', {
        pk: callerEventsPartition(harness),
        sk: `state#rejected-message#${messageId}`,
      }),
    );
    assertEventsConform(harness);
  });

  it('a second rejection of the same request extends its versions densely', async () => {
    const harness = conventionalHarness();
    const body = messageBody(runMessageObject({ run_id: OTHER_RUN_ID }));
    harness.source.send({ body, message_group_id: 'g-1', message_deduplication_id: 'd-1' });
    harness.source.send({ body, message_group_id: 'g-2', message_deduplication_id: 'd-2' });
    assert.equal((await poll(harness)).kind, 'completed');
    assert.equal((await poll(harness)).kind, 'completed');
    assert.deepEqual(
      requestStates(harness).map((state) => [state.version, state.effect_knowledge]),
      [
        [1, 'NOT_ATTEMPTED'],
        [2, 'NOT_ATTEMPTED'],
      ],
    );
    assertNoProviderCall(harness);
  });
});

function callerEventsPartition(harness: ConventionalHarness): string {
  const [first] = callerEvents(harness);
  return `${String(first?.run_id)}#${String(first?.trial_id)}`;
}
